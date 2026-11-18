import { bcs } from "@mysten/sui/bcs";
import { normalizeSuiAddress } from "@mysten/sui/utils";

/**
 * Deterministic "hard rule" policy for the agent key.
 *
 * A pure function of (transaction bytes, config). It never touches the network, the clock
 * or a model, so the UI can run it before requesting approval and the signer can run the
 * very same code on the exact bytes immediately before signing.
 *
 * It guards what the *agent key* may sign. It deliberately does not duplicate the vault's
 * spending limits: the Move contract is the final authority on those. This layer is the
 * only one that sees the whole transaction, so it denies everything the contract cannot
 * see (object transfers, other packages, publishes, large gas budgets, foreign objects).
 */

export const DEFAULT_MAX_GAS_BUDGET_MIST = 100_000_000n; // 0.1 SUI

/** Vault functions the agent may call. Owner functions are intentionally absent. */
export const AGENT_VAULT_FUNCTIONS = [
  "spend",
  "spend_with_clock",
  "spend_approved",
  "stake",
  "begin_swap",
  "begin_swap_auto",
  "finish_swap",
] as const;

/** DEX entry points the swap flow may call. */
export const POOL_FUNCTIONS = ["swap_sui_for_usdc", "swap_usdc_for_sui"] as const;

const SUI_CLOCK = normalizeSuiAddress("0x6");
const SUI_SYSTEM_STATE = normalizeSuiAddress("0x5");

export interface PolicyConfig {
  /** The agent wallet address: the only sender and gas owner allowed. */
  agentAddress: string;
  /** The current vault package. Older package IDs are not allowed (they predate policy). */
  vaultPackageId: string;
  vaultId: string;
  agentCapId: string;
  /** Mock DEX package and pool. Omit to forbid swaps through any DEX. */
  pool?: { packageId: string; poolId: string };
  maxGasBudgetMist?: bigint;
}

export interface PolicyDecision {
  allowed: boolean;
  /** Stable machine-readable codes, one per violated rule. Empty when allowed. */
  reasons: string[];
  /** Human-readable list of the calls the transaction makes. Empty if it could not be parsed. */
  calls: string[];
}

function deny(reasons: string[], calls: string[] = []): PolicyDecision {
  return { allowed: false, reasons, calls };
}

export function evaluateTransaction(bytes: Uint8Array, config: PolicyConfig): PolicyDecision {
  let data: ReturnType<typeof bcs.TransactionData.parse>;
  try {
    data = bcs.TransactionData.parse(bytes);
  } catch {
    return deny(["unparseable_transaction"]);
  }
  if (!data.V1) return deny(["unsupported_transaction_version"]);

  const reasons: string[] = [];
  const calls: string[] = [];
  const { kind, sender, gasData } = data.V1;
  const agent = normalizeSuiAddress(config.agentAddress);
  const vaultPackage = normalizeSuiAddress(config.vaultPackageId);
  const maxGas = config.maxGasBudgetMist ?? DEFAULT_MAX_GAS_BUDGET_MIST;

  if (normalizeSuiAddress(sender) !== agent) reasons.push("sender_not_agent");
  if (normalizeSuiAddress(gasData.owner) !== agent) reasons.push("gas_owner_not_agent");
  if (BigInt(gasData.budget) > maxGas) reasons.push("gas_budget_too_high");

  if (!kind.ProgrammableTransaction) {
    reasons.push("not_programmable_transaction");
    return deny(reasons);
  }
  const { inputs, commands } = kind.ProgrammableTransaction;

  // Inputs: only plain values and the objects the agent flows legitimately use.
  const allowedObjects = new Set(
    [config.vaultId, config.agentCapId, SUI_CLOCK, SUI_SYSTEM_STATE, config.pool?.poolId]
      .filter((id): id is string => Boolean(id))
      .map((id) => normalizeSuiAddress(id)),
  );
  for (const input of inputs) {
    if (input.Pure) continue;
    const object = input.Object;
    if (!object) {
      reasons.push("unsupported_input_kind");
      continue;
    }
    const ref = object.ImmOrOwnedObject ?? object.SharedObject ?? object.Receiving;
    const id = ref ? normalizeSuiAddress(ref.objectId) : undefined;
    if (!id || !allowedObjects.has(id)) reasons.push("foreign_object_input");
  }

  if (commands.length === 0) reasons.push("no_commands");

  const vaultFunctions = new Set<string>(AGENT_VAULT_FUNCTIONS);
  const poolFunctions = new Set<string>(POOL_FUNCTIONS);
  for (const command of commands) {
    const move = command.MoveCall;
    if (!move) {
      // TransferObjects, SplitCoins, MergeCoins, MakeMoveVec, Publish, Upgrade.
      reasons.push(`command_not_allowed:${Object.keys(command)[0] ?? "unknown"}`);
      continue;
    }
    const target = `${normalizeSuiAddress(move.package)}::${move.module}::${move.function}`;
    calls.push(target);
    const pkg = normalizeSuiAddress(move.package);
    if (pkg === vaultPackage && move.module === "spending_vault") {
      if (!vaultFunctions.has(move.function)) reasons.push(`vault_function_not_allowed:${move.function}`);
    } else if (
      config.pool &&
      pkg === normalizeSuiAddress(config.pool.packageId) &&
      move.module === "test_usdc"
    ) {
      if (!poolFunctions.has(move.function)) reasons.push(`pool_function_not_allowed:${move.function}`);
    } else {
      reasons.push(`call_target_not_allowed:${target}`);
    }
  }

  const unique = [...new Set(reasons)];
  return { allowed: unique.length === 0, reasons: unique, calls };
}
