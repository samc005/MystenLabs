// Owner-side vault transactions, built so the OWNER's key signs them.
//
// create_secure transfers the OwnerCap to ctx.sender(), so whoever signs creation owns the vault.
// That is the whole point of this module: these run in the user's browser with the user's key,
// and the server never sees an owner key. Mirrors wallet-mcp/src/blockchain/owner.ts, which does
// the same calls from the CLI. Pure builders are separate from the chain lookups so they test
// without a network.

import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";

const MODULE = "spending_vault";
const MAX_RECIPIENTS = 20;

export interface OnboardingPolicy {
  /** create_secure's hard per-transaction ceiling. */
  perTxLimitMist: bigint;
  /** Spend policy: most the agent may spend per epoch. */
  spendCapMist: bigint;
  dayCapMist: bigint;
  weekCapMist: bigint;
  /** Moved from the owner wallet into the vault, so the agent has something to spend. */
  depositMist: bigint;
  /** Sent to the agent address so it can pay gas. It is not spendable policy money. */
  agentGasMist: bigint;
  /** Recipients the agent may pay directly. Empty means every payment needs owner approval. */
  allowedRecipients: string[];
}

const SUI = 1_000_000_000n;

export const DEFAULT_ONBOARDING_POLICY: OnboardingPolicy = {
  perTxLimitMist: SUI / 10n,
  spendCapMist: SUI / 10n,
  dayCapMist: SUI / 10n,
  weekCapMist: SUI / 2n,
  depositMist: SUI / 10n,
  agentGasMist: SUI / 20n,
  allowedRecipients: [],
};

/** SUI the owner wallet needs on hand: deposit, agent gas, and a buffer for the two transactions' own gas. */
export function requiredOwnerBalanceMist(policy: OnboardingPolicy): bigint {
  return policy.depositMist + policy.agentGasMist + SUI / 50n;
}

const U64_MAX = (1n << 64n) - 1n;

/** Returns a copy with normalized, de-duplicated recipients. Throws a user-readable error on bad input. */
export function validatePolicy(policy: OnboardingPolicy): OnboardingPolicy {
  const positive: [string, bigint][] = [
    ["Per-transaction limit", policy.perTxLimitMist],
    ["Per-epoch spend cap", policy.spendCapMist],
    ["Daily cap", policy.dayCapMist],
    ["Weekly cap", policy.weekCapMist],
    ["Vault deposit", policy.depositMist],
    ["Agent gas", policy.agentGasMist],
  ];
  for (const [label, value] of positive) {
    if (value <= 0n || value > U64_MAX) throw new Error(`${label} must be a positive amount.`);
  }
  if (policy.dayCapMist > policy.weekCapMist) throw new Error("The daily cap cannot exceed the weekly cap.");
  const recipients: string[] = [];
  for (const raw of policy.allowedRecipients) {
    if (!isValidSuiAddress(raw.trim())) throw new Error(`"${raw.trim()}" is not a valid Sui address.`);
    const address = normalizeSuiAddress(raw.trim());
    if (!recipients.includes(address)) recipients.push(address);
  }
  if (recipients.length > MAX_RECIPIENTS) throw new Error(`Allow at most ${MAX_RECIPIENTS} recipients at setup.`);
  return { ...policy, allowedRecipients: recipients };
}

/** Step 1: creates the shared Vault and sends its OwnerCap to the signer. */
export function buildCreateVaultTx(packageId: string, perTxLimitMist: bigint): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::${MODULE}::create_secure`,
    arguments: [tx.pure.u64(perTxLimitMist)],
  });
  return tx;
}

/**
 * Step 2, one atomic transaction: authorize the account's agent, give it gas, set every limit,
 * allowlist recipients, fund the vault, and only then enable payments for the agent.
 * Either the whole account is configured or none of it is.
 */
export function buildSetupTx(input: {
  packageId: string;
  vaultId: string;
  ownerCapId: string;
  agentAddress: string;
  policy: OnboardingPolicy;
}): Transaction {
  const policy = validatePolicy(input.policy);
  const call = (name: string) => `${input.packageId}::${MODULE}::${name}`;
  const tx = new Transaction();
  const cap = tx.object(input.ownerCapId);
  const vault = tx.object(input.vaultId);

  tx.moveCall({ target: call("issue_agent_cap"), arguments: [cap, vault, tx.pure.address(input.agentAddress)] });
  tx.transferObjects([coinWithBalance({ balance: policy.agentGasMist })(tx)], input.agentAddress);
  tx.moveCall({
    target: call("set_spend_policy"),
    arguments: [cap, vault, tx.pure.u64(policy.spendCapMist), tx.pure.bool(true)],
  });
  tx.moveCall({
    target: call("set_calendar_policy"),
    arguments: [cap, vault, tx.pure.u64(policy.dayCapMist), tx.pure.u64(policy.weekCapMist), tx.object.clock()],
  });
  for (const recipient of policy.allowedRecipients) {
    tx.moveCall({ target: call("allow_recipient"), arguments: [cap, vault, tx.pure.address(recipient)] });
  }
  tx.moveCall({ target: call("deposit"), arguments: [vault, coinWithBalance({ balance: policy.depositMist })(tx)] });
  tx.moveCall({
    target: call("set_agent_security_policy"),
    arguments: [cap, vault, tx.pure.bool(true), tx.pure.bool(false), tx.pure.bool(false)],
  });
  return tx;
}

// ---- Chain lookups, shared by the browser flow and the server-side verification. ----

interface ObjectLike {
  objectId?: string;
  type?: string;
  version?: string | number | bigint;
  owner?: { AddressOwner?: string; ConsensusAddressOwner?: { owner?: string } } | null;
  json?: Record<string, unknown> | null;
}

export interface ChainReader {
  getObject(args: { objectId: string; include: { json: true } }): Promise<{ object: ObjectLike }>;
  listOwnedObjects(args: {
    owner: string;
    type: string;
    include: { json: true };
    cursor?: string | null;
  }): Promise<{ objects: ObjectLike[]; hasNextPage: boolean; cursor: string | null }>;
}

export function ownerOf(object: ObjectLike): string | undefined {
  return object.owner?.AddressOwner ?? object.owner?.ConsensusAddressOwner?.owner;
}

export function vaultType(packageId: string, name: "Vault" | "OwnerCap" | "AgentCap"): string {
  return `${normalizeSuiAddress(packageId)}::${MODULE}::${name}`;
}

async function listAll(reader: ChainReader, owner: string, type: string): Promise<ObjectLike[]> {
  const found: ObjectLike[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const result: Awaited<ReturnType<ChainReader["listOwnedObjects"]>> = await reader.listOwnedObjects({
      owner,
      type,
      include: { json: true },
      cursor,
    });
    found.push(...result.objects);
    if (!result.hasNextPage) break;
    cursor = result.cursor;
  }
  return found;
}

/** The OwnerCap this address holds for a vault of this package, skipping vaults already registered. */
export async function findOwnerCap(
  reader: ChainReader,
  owner: string,
  packageId: string,
  excludeVaultIds: string[] = [],
): Promise<{ ownerCapId: string; vaultId: string } | undefined> {
  const caps = await listAll(reader, owner, vaultType(packageId, "OwnerCap"));
  for (const cap of caps) {
    const vaultId = cap.json?.vault_id;
    if (cap.objectId && typeof vaultId === "string" && !excludeVaultIds.includes(vaultId)) {
      return { ownerCapId: cap.objectId, vaultId };
    }
  }
  return undefined;
}

/** The AgentCap the account's agent address holds for this vault, if the setup transaction has landed. */
export async function findAgentCap(
  reader: ChainReader,
  agentAddress: string,
  packageId: string,
  vaultId: string,
  /** When known, only a cap of the vault's current generation counts. A rotated-out cap is revoked. */
  agentVersion?: unknown,
): Promise<{ agentCapId: string } | undefined> {
  const caps = await listAll(reader, agentAddress, vaultType(packageId, "AgentCap"));
  const cap = caps.find(
    (candidate) =>
      candidate.json?.vault_id === vaultId &&
      (agentVersion === undefined || String(candidate.json?.version) === String(agentVersion)),
  );
  return cap?.objectId ? { agentCapId: cap.objectId } : undefined;
}
