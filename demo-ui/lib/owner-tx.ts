// Owner-side vault transactions, built so the OWNER's key signs them.
//
// create_secure transfers the OwnerCap to ctx.sender(), so whoever signs creation owns the vault.
// That is the whole point of this module: these run in the user's browser with the user's key,
// and the server never sees an owner key. Mirrors wallet-mcp/src/blockchain/owner.ts, which does
// the same calls from the CLI. Pure builders are separate from the chain lookups so they test
// without a network.

import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { isValidSuiAddress, normalizeSuiAddress, toHex } from "@mysten/sui/utils";

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

/** Normalizes and de-duplicates Sui addresses. Throws a user-readable error on a malformed one. */
export function normalizeRecipients(raw: string[]): string[] {
  const recipients: string[] = [];
  for (const entry of raw) {
    if (!isValidSuiAddress(entry.trim())) throw new Error(`"${entry.trim()}" is not a valid Sui address.`);
    const address = normalizeSuiAddress(entry.trim());
    if (!recipients.includes(address)) recipients.push(address);
  }
  return recipients;
}

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
  const recipients = normalizeRecipients(policy.allowedRecipients);
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

// ---- Owner edits after setup. Only the sections the owner changed are sent. ----

export interface PolicyChanges {
  /** Hard per-transaction ceiling. Must be positive. */
  perTxLimitMist?: bigint;
  /** Daily cap for direct spends (0 blocks them) and whether only allowlisted recipients may be paid. */
  spend?: { dailyCapMist: bigint; enforceRecipients: boolean };
  /** Day and week caps. Each is zero or more, and the day cap cannot exceed the week cap. 0 blocks that window. */
  calendar?: { dayCapMist: bigint; weekCapMist: bigint };
  allowRecipients?: string[];
  disallowRecipients?: string[];
}

/** Checks a set of edits and returns it with normalized recipients. Throws a user-readable error. */
export function validatePolicyChanges(changes: PolicyChanges): PolicyChanges & {
  allowRecipients: string[];
  disallowRecipients: string[];
} {
  if (changes.perTxLimitMist !== undefined && (changes.perTxLimitMist <= 0n || changes.perTxLimitMist > U64_MAX)) {
    throw new Error("Per-transaction limit must be a positive amount.");
  }
  if (changes.spend && (changes.spend.dailyCapMist < 0n || changes.spend.dailyCapMist > U64_MAX)) {
    throw new Error("Daily cap must be zero or more.");
  }
  if (changes.calendar) {
    const { dayCapMist, weekCapMist } = changes.calendar;
    if (dayCapMist < 0n || weekCapMist < 0n || weekCapMist > U64_MAX || dayCapMist > U64_MAX) {
      throw new Error("Daily and weekly caps must be zero or more.");
    }
    if (dayCapMist > weekCapMist) throw new Error("The daily cap cannot exceed the weekly cap.");
  }
  const allowRecipients = normalizeRecipients(changes.allowRecipients ?? []);
  const disallowRecipients = normalizeRecipients(changes.disallowRecipients ?? []);
  if (allowRecipients.some((address) => disallowRecipients.includes(address))) {
    throw new Error("An address cannot be both added and removed.");
  }
  if (allowRecipients.length > MAX_RECIPIENTS) throw new Error(`Add at most ${MAX_RECIPIENTS} recipients at once.`);
  const hasChange =
    changes.perTxLimitMist !== undefined ||
    changes.spend !== undefined ||
    changes.calendar !== undefined ||
    allowRecipients.length > 0 ||
    disallowRecipients.length > 0;
  if (!hasChange) throw new Error("Nothing to change.");
  return { ...changes, allowRecipients, disallowRecipients };
}

/**
 * One owner transaction with a call for each section that changed. The owner's OwnerCap signs it;
 * the agent is not involved and cannot raise its own limits.
 */
export function buildPolicyUpdateTx(input: {
  packageId: string;
  vaultId: string;
  ownerCapId: string;
  changes: PolicyChanges;
}): Transaction {
  const changes = validatePolicyChanges(input.changes);
  const call = (name: string) => `${input.packageId}::${MODULE}::${name}`;
  const tx = new Transaction();
  const cap = tx.object(input.ownerCapId);
  const vault = tx.object(input.vaultId);

  if (changes.perTxLimitMist !== undefined) {
    tx.moveCall({ target: call("set_per_tx_limit"), arguments: [cap, vault, tx.pure.u64(changes.perTxLimitMist)] });
  }
  if (changes.spend) {
    tx.moveCall({
      target: call("set_spend_policy"),
      arguments: [cap, vault, tx.pure.u64(changes.spend.dailyCapMist), tx.pure.bool(changes.spend.enforceRecipients)],
    });
  }
  if (changes.calendar) {
    tx.moveCall({
      target: call("set_calendar_policy"),
      arguments: [
        cap,
        vault,
        tx.pure.u64(changes.calendar.dayCapMist),
        tx.pure.u64(changes.calendar.weekCapMist),
        tx.object.clock(),
      ],
    });
  }
  for (const recipient of changes.allowRecipients) {
    tx.moveCall({ target: call("allow_recipient"), arguments: [cap, vault, tx.pure.address(recipient)] });
  }
  for (const recipient of changes.disallowRecipients) {
    tx.moveCall({ target: call("disallow_recipient"), arguments: [cap, vault, tx.pure.address(recipient)] });
  }
  return tx;
}

/** The limits as they are on-chain. Read from the vault's dynamic fields, not from our server. */
export interface VaultPolicy {
  perTxLimitMist: bigint;
  spend: { dailyCapMist: bigint; enforceRecipients: boolean } | null;
  calendar: { dayCapMist: bigint; weekCapMist: bigint } | null;
  allowedRecipients: string[];
}

interface DynamicFieldEntry {
  fieldId: string;
  $kind: string;
  name: { type: string; bcs: Uint8Array };
}

/** The subset of the gRPC client used to read a vault's policy. Tests pass a fake. */
export interface PolicyReader {
  getObjects(args: { objectIds: string[]; include: { json: true } }): Promise<{ objects: (ObjectLike | Error)[] }>;
  listDynamicFields(args: {
    parentId: string;
    cursor?: string | null;
    include: { value: true };
  }): Promise<{ dynamicFields: DynamicFieldEntry[]; hasNextPage: boolean; cursor: string | null }>;
}

function u64Field(value: unknown, label: string): bigint {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return BigInt(value);
  throw new Error(`Unexpected ${label} on the vault.`);
}

export async function readVaultPolicy(reader: PolicyReader, vaultId: string): Promise<VaultPolicy> {
  const [vault] = (await reader.getObjects({ objectIds: [vaultId], include: { json: true } })).objects;
  if (!vault || vault instanceof Error || !vault.json) throw new Error("Could not read the vault on-chain.");

  const allowedRecipients: string[] = [];
  let spendFieldId: string | undefined;
  let calendarFieldId: string | undefined;
  let cursor: string | null = null;
  do {
    const page = await reader.listDynamicFields({ parentId: vaultId, cursor, include: { value: true } });
    for (const entry of page.dynamicFields) {
      if (entry.name.type.includes("::spending_vault::AllowedRecipient")) {
        allowedRecipients.push(normalizeSuiAddress(`0x${toHex(entry.name.bcs)}`));
      } else if (entry.name.type.includes("::spending_vault::SpendPolicyKey")) {
        spendFieldId = entry.fieldId;
      } else if (entry.name.type.includes("::spending_vault::CalendarPolicyKey")) {
        calendarFieldId = entry.fieldId;
      }
    }
    cursor = page.hasNextPage ? page.cursor : null;
  } while (cursor);

  // A dynamic field's JSON is { id, name, value }; for struct values, `value` holds the fields.
  const valueById = new Map<string, Record<string, unknown>>();
  const fieldIds = [spendFieldId, calendarFieldId].filter((id): id is string => id !== undefined);
  if (fieldIds.length > 0) {
    const { objects } = await reader.getObjects({ objectIds: fieldIds, include: { json: true } });
    for (const object of objects) {
      if (object instanceof Error || !object.json || !object.objectId) continue;
      const value = object.json.value;
      if (value && typeof value === "object") valueById.set(object.objectId, value as Record<string, unknown>);
    }
  }

  const spendValue = spendFieldId ? valueById.get(spendFieldId) : undefined;
  const calendarValue = calendarFieldId ? valueById.get(calendarFieldId) : undefined;
  return {
    perTxLimitMist: u64Field(vault.json.per_tx_limit, "per-transaction limit"),
    spend: spendValue
      ? {
          dailyCapMist: u64Field(spendValue.daily_cap, "daily cap"),
          enforceRecipients: spendValue.enforce_recipients === true,
        }
      : null,
    calendar: calendarValue
      ? {
          dayCapMist: u64Field(calendarValue.day_cap, "day cap"),
          weekCapMist: u64Field(calendarValue.week_cap, "week cap"),
        }
      : null,
    allowedRecipients: allowedRecipients.sort(),
  };
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
