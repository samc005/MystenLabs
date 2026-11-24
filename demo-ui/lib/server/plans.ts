// Payment plans on the server: record a plan from the owner's signed transaction, cancel it, and
// run due payments.
//
// Trust boundary: the server never takes a plan's terms from the browser. It reads the owner's
// transaction from the chain and records only the SpendIntents that transaction created, on this
// account's vault, signed by this account's owner. The scheduler can only run those intents, and
// the contract enforces each one's recipient, amount, single use and deadline. The scheduler's
// only freedom is timing inside each payment's window.

import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import { createSuiClient } from "@/lib/sui";
import { MAX_PLAN_PAYMENTS } from "@/lib/plan";
import { contextFor, type AccountContext } from "./account-context";
import { listAccounts } from "./accounts";
import { mutate, read, saveNote, type PaymentPlan } from "./account-store";
import { connectWalletMcp } from "./agent";
import { passkeyStatus } from "./passkey";

const DAY_MS = 24 * 60 * 60 * 1000;

interface ChainEvent {
  packageId: string;
  module: string;
  sender: string;
  eventType: string;
  json: Record<string, unknown> | null;
}

async function ownerEvents(account: AccountContext, digest: string, name: string): Promise<Record<string, unknown>[]> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(digest)) throw new Error("Not a transaction digest.");
  const result = await createSuiClient().waitForTransaction({ digest, include: { events: true }, timeout: 30_000 });
  if (result.$kind !== "Transaction") throw new Error("That transaction failed on-chain.");
  const events = (result.Transaction.events ?? []) as unknown as ChainEvent[];
  const pkg = normalizeSuiAddress(account.packageId);
  return events
    .filter(
      (event) =>
        normalizeSuiAddress(event.packageId) === pkg &&
        event.module === "spending_vault" &&
        event.eventType.endsWith(`::spending_vault::${name}`) &&
        normalizeSuiAddress(event.sender) === account.ownerAddress &&
        event.json &&
        normalizeSuiAddress(String(event.json.vault_id)) === normalizeSuiAddress(account.vaultId),
    )
    .map((event) => event.json!);
}

/** Records a plan from the owner's transaction. Every term comes from the chain. */
export async function registerPlan(account: AccountContext, digest: string, note: string | null): Promise<PaymentPlan> {
  const created = await ownerEvents(account, digest, "SpendIntentCreated");
  if (created.length === 0) throw new Error("That transaction did not create any payment approvals on your vault.");
  if (created.length > MAX_PLAN_PAYMENTS) throw new Error("Too many payments for one plan.");
  const intents = created
    .map((event) => ({
      intentId: normalizeSuiAddress(String(event.intent_id)),
      recipient: normalizeSuiAddress(String(event.recipient)),
      amount: String(event.amount),
      expiry: Number(event.expiry_ms),
    }))
    .sort((a, b) => a.expiry - b.expiry);
  const [first] = intents;
  if (intents.some((intent) => intent.recipient !== first.recipient || intent.amount !== first.amount)) {
    throw new Error("A plan pays one recipient the same amount each time.");
  }
  const step = intents.length > 1 ? intents[1].expiry - intents[0].expiry : DAY_MS;
  const every: "day" | "week" = step >= 7 * DAY_MS ? "week" : "day";
  const interval = every === "week" ? 7 * DAY_MS : DAY_MS;

  return mutate(account.accountId, "plans", (plans) => {
    const existing = plans.find((plan) => plan.createdDigest === digest);
    if (existing) return existing;
    const plan: PaymentPlan = {
      id: digest,
      recipient: first.recipient,
      amountMist: first.amount,
      every,
      count: intents.length,
      note: note && /^[A-Za-z0-9][A-Za-z0-9 ,.'!?&()$#@:/+-]{0,79}$/.test(note) ? note : null,
      createdDigest: digest,
      createdAt: new Date().toISOString(),
      payments: intents.map((intent) => ({
        intentId: intent.intentId,
        dueAt: new Date(intent.expiry - interval).toISOString(),
        expiresAt: new Date(intent.expiry).toISOString(),
        status: "scheduled" as const,
      })),
    };
    plans.push(plan);
    return plan;
  });
}

/** Marks payments cancelled once the owner's cancel transaction is confirmed on-chain. */
export async function recordCancellation(account: AccountContext, planId: string, digest: string): Promise<PaymentPlan> {
  const cancelled = new Set(
    (await ownerEvents(account, digest, "SpendIntentCancelled")).map((event) => normalizeSuiAddress(String(event.intent_id))),
  );
  return mutate(account.accountId, "plans", (plans) => {
    const plan = plans.find((candidate) => candidate.id === planId);
    if (!plan) throw new Error("Unknown plan.");
    for (const payment of plan.payments) {
      if (payment.status === "scheduled" && cancelled.has(payment.intentId)) payment.status = "cancelled";
    }
    return plan;
  });
}

/**
 * Submits one plan payment through the isolated signer. The bytes are built here, from a plan
 * record that was itself read from the chain: exactly one spend_approved call on this account's
 * vault with this account's AgentCap. No passkey: the owner approved every payment up front by
 * signing the plan.
 */
async function submitPlanPayment(account: AccountContext, intentId: string): Promise<string> {
  const directory = process.env.SUI_SIGNER_STATE_DIR;
  if (!directory || !path.isAbsolute(directory)) throw new Error("Configure the trusted backend SUI_SIGNER_STATE_DIR.");
  const info = await stat(directory);
  if (!info.isDirectory() || info.mode & 0o077 || info.uid !== process.getuid?.()) {
    throw new Error("Signer state must be private and owned by the trusted backend user.");
  }
  const client = createSuiClient();
  const tx = new Transaction();
  tx.setSender(account.agentAddress);
  tx.moveCall({
    target: `${account.packageId}::spending_vault::spend_approved`,
    arguments: [tx.object(account.agentCapId), tx.object(account.vaultId), tx.pure.id(intentId), tx.object.clock()],
  });
  const bytes = toBase64(await tx.build({ client }));
  const id = `plan-${intentId.slice(2, 18)}-${Date.now()}`;
  const input = { network: "testnet", proposalId: id, transactionBytes: bytes, policyDecision: { id, allowed: true } };
  const mcp = await connectWalletMcp(account);
  try {
    const simulation = await mcp.callTool({ name: "estimate_gas", arguments: { transactionBase64: bytes } });
    if (simulation.isError) throw new Error("The payment failed in simulation (the vault may be short or paused).");
    const approvals = path.join(directory, "approvals");
    await mkdir(approvals, { recursive: true, mode: 0o700 });
    const temp = path.join(approvals, `${id}.tmp`);
    await writeFile(temp, JSON.stringify({ ...input, expiresAtMs: Date.now() + 30_000 }), { mode: 0o600, flag: "wx" });
    await rename(temp, path.join(approvals, `${id}.json`));
    const result = await mcp.callTool({ name: "execute_approved_transaction", arguments: input });
    const confirmation = result.structuredContent as { digest?: unknown; confirmed?: unknown } | undefined;
    if (result.isError || typeof confirmation?.digest !== "string") throw new Error("The signer did not confirm the payment.");
    return confirmation.digest;
  } finally {
    await mcp.close().catch(() => undefined);
  }
}

let running = false;

/** Runs every plan payment that is due. Safe to call often; one pass at a time. */
export async function runDuePlanPayments(now = Date.now()): Promise<{ paid: number; failed: number }> {
  if (running) return { paid: 0, failed: 0 };
  running = true;
  let paid = 0;
  let failed = 0;
  try {
    if ((await passkeyStatus()).revoked) return { paid, failed }; // Wallet locked: run nothing.
    for (const record of await listAccounts()) {
      if (record.status !== "active" || !record.vault) continue;
      const plans = await read(record.id, "plans");
      const due = plans.flatMap((plan) =>
        plan.payments
          .filter((payment) => payment.status === "scheduled" && Date.parse(payment.dueAt) <= now)
          .map((payment) => ({ plan, payment })),
      );
      if (due.length === 0) continue;
      const account = await contextFor(record);
      for (const { plan, payment } of due) {
        let update: Partial<typeof payment>;
        if (Date.parse(payment.expiresAt) <= now) {
          update = { status: "expired" };
        } else {
          try {
            const digest = await submitPlanPayment(account, payment.intentId);
            update = { status: "paid", digest };
            if (plan.note) await saveNote(record.id, digest, plan.note).catch(() => undefined);
            paid += 1;
          } catch (error) {
            // Leave it scheduled while its window is open so a short vault can be topped up; the
            // error shows on the dashboard. It expires on its own when the window closes.
            update = { error: error instanceof Error ? error.message : String(error) };
            failed += 1;
          }
        }
        await mutate(record.id, "plans", (all) => {
          const target = all.find((p) => p.id === plan.id)?.payments.find((p) => p.intentId === payment.intentId);
          if (target && target.status === "scheduled") Object.assign(target, update);
        });
      }
    }
  } finally {
    running = false;
  }
  return { paid, failed };
}
