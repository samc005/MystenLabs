import { normalizeStructTag, normalizeSuiAddress, SUI_TYPE_ARG } from "@mysten/sui/utils";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { DEFAULT_MAX_GAS_BUDGET_MIST } from "./evaluate.js";

/**
 * Stage 2 of the hard rules: judge what a transaction would actually do, using a dry run.
 *
 * `evaluateEffects` is a pure function of the simulated effects, so it is as deterministic
 * as the static stage. The dry run itself must be performed by whoever enforces the rule
 * (the signer runs its own); a simulation handed over by the UI is not evidence.
 *
 * Stage 1 (`evaluateTransaction`) says which calls the bytes make. Stage 2 says where value
 * would move. Swap proceeds and stakes stay inside the vault, so they show up here as "no
 * credit to anyone": the contract (min_out, stake policy) remains the authority on those.
 */

export interface SimulatedEffects {
  success: boolean;
  error: string | null;
  balanceChanges: { address: string; coinType: string; amount: string }[];
  changedObjects: {
    objectId: string;
    idOperation: string;
    outputState: string;
    outputOwnerAddress: string | null;
  }[];
}

/** What the person approved. Absent means "this transaction should pay no one". */
export interface EffectsExpectation {
  /** Recipient address -> the most MIST of SUI they may receive. */
  credits?: Record<string, bigint>;
}

export interface EffectsConfig {
  agentAddress: string;
  agentCapId: string;
  maxGasBudgetMist?: bigint;
}

export interface EffectsDecision {
  allowed: boolean;
  reasons: string[];
}

const SUI = normalizeStructTag(SUI_TYPE_ARG);

export function evaluateEffects(
  effects: SimulatedEffects,
  config: EffectsConfig,
  expectation: EffectsExpectation = {},
): EffectsDecision {
  const reasons: string[] = [];
  const agent = normalizeSuiAddress(config.agentAddress);
  const maxGas = config.maxGasBudgetMist ?? DEFAULT_MAX_GAS_BUDGET_MIST;
  const allowed = new Map(
    Object.entries(expectation.credits ?? {}).map(([address, max]) => [normalizeSuiAddress(address), max]),
  );

  if (!effects.success) reasons.push("simulation_failed");

  for (const change of effects.balanceChanges) {
    const address = normalizeSuiAddress(change.address);
    const amount = BigInt(change.amount);
    const isSui = normalizeStructTag(change.coinType) === SUI;
    if (address === agent) {
      if (amount < 0n && (!isSui || -amount > maxGas)) reasons.push("agent_balance_drain");
      continue;
    }
    if (amount <= 0n) continue; // others losing value is not our concern here
    const limit = isSui ? allowed.get(address) : undefined;
    if (limit === undefined) reasons.push("unexpected_credit");
    else if (amount > limit) reasons.push("credit_exceeds_approval");
  }

  const cap = normalizeSuiAddress(config.agentCapId);
  for (const object of effects.changedObjects) {
    if (normalizeSuiAddress(object.objectId) !== cap) continue;
    const gone = object.idOperation === "Deleted" || object.outputState === "DoesNotExist";
    const owner = object.outputOwnerAddress === null ? null : normalizeSuiAddress(object.outputOwnerAddress);
    if (gone || owner !== agent) reasons.push("agent_cap_moved");
  }

  const unique = [...new Set(reasons)];
  return { allowed: unique.length === 0, reasons: unique };
}

/** Dry-runs the exact bytes on the node and reduces the result to what the rules read. */
export async function simulateForPolicy(
  client: SuiGrpcClient,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<SimulatedEffects> {
  const result = await client.simulateTransaction({
    transaction: bytes,
    include: { effects: true, balanceChanges: true },
    ...(signal ? { signal } : {}),
  });
  const executed = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
  return {
    success: result.$kind === "Transaction" && executed.status.success,
    error: executed.status.error ? String(executed.status.error.message ?? executed.status.error) : null,
    balanceChanges: (executed.balanceChanges ?? []).map((c) => ({
      address: c.address,
      coinType: c.coinType,
      amount: c.amount,
    })),
    changedObjects: (executed.effects?.changedObjects ?? []).map((o) => {
      const owner = o.outputOwner;
      return {
        objectId: o.objectId,
        idOperation: o.idOperation,
        outputState: o.outputState,
        outputOwnerAddress:
          owner?.$kind === "AddressOwner"
            ? owner.AddressOwner
            : owner?.$kind === "ConsensusAddressOwner"
              ? owner.ConsensusAddressOwner.owner
              : null,
      };
    }),
  };
}
