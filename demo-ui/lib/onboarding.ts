// Browser-side account creation. The user's own wallet creates and configures the vault, so the
// user holds the OwnerCap. The server contributes only an agent address and a final on-chain check.
//
// Safe to re-run: every step looks at what already exists (server account, OwnerCap, AgentCap)
// and skips it, so a failed or closed tab resumes instead of creating a second vault or agent.

import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import {
  buildCreateVaultTx,
  buildSetupTx,
  findAgentCap,
  findOwnerCap,
  requiredOwnerBalanceMist,
  validatePolicy,
  type ChainReader,
  type OnboardingPolicy,
} from "./owner-tx";
import { createSuiClient, getSuiBalance, formatSui } from "./sui";

export type OnboardingStep = "check" | "agent" | "vault" | "configure" | "verify";

export interface OnboardingAccount {
  id: string;
  ownerAddress: string;
  agentAddress: string;
  status: "pending" | "active";
  vault?: { packageId: string; vaultId: string; ownerCapId: string; agentCapId: string };
}

type Client = ReturnType<typeof createSuiClient>;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status}).`);
  return body;
}

/** Signs with the owner's key, submits, and waits. Shared by onboarding and the settings page. */
export async function execute(client: Client, signer: Ed25519Keypair, tx: Transaction): Promise<string> {
  tx.setSender(signer.toSuiAddress());
  const submitted = await client.signAndExecuteTransaction({ transaction: tx, signer, include: { effects: true } });
  if (submitted.$kind === "FailedTransaction") {
    throw new Error(submitted.FailedTransaction.status.error?.message ?? "Transaction failed.");
  }
  const settled = await client.waitForTransaction({ result: submitted, timeout: 60_000 });
  if (settled.$kind === "FailedTransaction") {
    throw new Error(settled.FailedTransaction.status.error?.message ?? "Transaction failed.");
  }
  return settled.Transaction.digest;
}

/** Indexing can lag the transaction by a moment, so retry the lookup before giving up. */
async function eventually<T>(find: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const found = await find();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Created ${what}, but could not find it on-chain yet. Press Create again to resume.`);
}

export async function loadAccount(ownerAddress: string): Promise<OnboardingAccount | null> {
  const { account } = await api<{ account: OnboardingAccount | null }>(
    `/api/accounts?owner=${encodeURIComponent(ownerAddress)}`,
  );
  return account;
}

export async function createAccount(input: {
  owner: Ed25519Keypair;
  policy: OnboardingPolicy;
  onStep: (step: OnboardingStep, detail?: string) => void;
}): Promise<OnboardingAccount> {
  const { owner, onStep } = input;
  const policy = validatePolicy(input.policy);
  const ownerAddress = owner.toSuiAddress();
  const client = createSuiClient();
  const reader = client as unknown as ChainReader;

  onStep("check");
  const balance = await getSuiBalance(client, ownerAddress);
  const required = requiredOwnerBalanceMist(policy);
  if (balance < required) {
    throw new Error(
      `Your wallet has ${formatSui(balance)} SUI and needs about ${formatSui(required)} SUI ` +
        `(vault deposit, agent gas, and transaction fees). Fund it from the faucet first.`,
    );
  }

  onStep("agent");
  const { account, packageId } = await api<{ account: OnboardingAccount; packageId: string }>("/api/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerAddress }),
  });
  if (account.status === "active") return account;

  onStep("vault");
  let vault = await findOwnerCap(reader, ownerAddress, packageId);
  if (!vault) {
    await execute(client, owner, buildCreateVaultTx(packageId, policy.perTxLimitMist));
    vault = await eventually(() => findOwnerCap(reader, ownerAddress, packageId), "your vault");
  }

  onStep("configure");
  if (!(await findAgentCap(reader, account.agentAddress, packageId, vault.vaultId))) {
    await execute(
      client,
      owner,
      buildSetupTx({
        packageId,
        vaultId: vault.vaultId,
        ownerCapId: vault.ownerCapId,
        agentAddress: account.agentAddress,
        policy,
      }),
    );
    await eventually(() => findAgentCap(reader, account.agentAddress, packageId, vault.vaultId), "the agent authorization");
  }

  onStep("verify");
  const done = await api<{ account: OnboardingAccount }>("/api/accounts/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: account.id, vaultId: vault.vaultId, ownerCapId: vault.ownerCapId }),
  });
  return done.account;
}
