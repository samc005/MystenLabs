// Payment plans: "pay Sam 0.1 SUI every day for 10 days".
//
// The owner signs ONE transaction that creates one on-chain approval (a SpendIntent) per payment.
// Each approval fixes the recipient and amount and has its own deadline. The scheduler only picks
// WHEN to run each one, inside its window; it cannot change who is paid, how much, or how many.
// Payment i is due at start + i * interval and its approval expires one interval later.

import { coinWithBalance, Transaction } from "@mysten/sui/transactions";

export const MAX_PLAN_PAYMENTS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function intervalMs(every: "day" | "week"): number {
  return every === "week" ? 7 * DAY_MS : DAY_MS;
}

export interface PlanInput {
  recipient: string;
  amountMist: string;
  every: "day" | "week";
  count: number;
  /** When the first payment is due (ms). The first one runs right away. */
  startMs: number;
  /** Optional top-up of the vault in the same transaction, so the plan is funded. */
  depositMist: string;
}

/** Deadlines for each payment's approval. */
export function planDeadlines(input: Pick<PlanInput, "every" | "count" | "startMs">): number[] {
  const step = intervalMs(input.every);
  return Array.from({ length: input.count }, (_, i) => input.startMs + (i + 1) * step);
}

export function validatePlan(input: PlanInput): void {
  if (!/^0x[0-9a-f]{64}$/.test(input.recipient)) throw new Error("Recipient must be a full address.");
  if (!/^[1-9][0-9]*$/.test(input.amountMist)) throw new Error("Each payment must be more than zero.");
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_PLAN_PAYMENTS) {
    throw new Error(`A plan can have 1 to ${MAX_PLAN_PAYMENTS} payments.`);
  }
  if (input.every !== "day" && input.every !== "week") throw new Error("Plans run every day or every week.");
  if (!/^[0-9]+$/.test(input.depositMist)) throw new Error("Invalid top-up amount.");
}

/** One owner transaction: optional top-up, then one approval per payment. Pure, so it is tested. */
export function buildPlanTx(input: PlanInput, vault: { packageId: string; vaultId: string; ownerCapId: string }): Transaction {
  validatePlan(input);
  const tx = new Transaction();
  const call = (name: string) => `${vault.packageId}::spending_vault::${name}`;
  if (BigInt(input.depositMist) > 0n) {
    tx.moveCall({ target: call("deposit"), arguments: [tx.object(vault.vaultId), coinWithBalance({ balance: BigInt(input.depositMist) })(tx)] });
  }
  for (const expiry of planDeadlines(input)) {
    tx.moveCall({
      target: call("create_spend_intent"),
      arguments: [
        tx.object(vault.ownerCapId),
        tx.object(vault.vaultId),
        tx.pure.address(input.recipient),
        tx.pure.u64(BigInt(input.amountMist)),
        tx.pure.u64(BigInt(expiry)),
        tx.object.clock(),
      ],
    });
  }
  return tx;
}

/** Withdraws the approvals for payments that have not run yet. */
export function buildCancelPlanTx(intentIds: string[], vault: { packageId: string; vaultId: string; ownerCapId: string }): Transaction {
  if (intentIds.length === 0) throw new Error("Nothing left to cancel.");
  const tx = new Transaction();
  for (const intentId of intentIds) {
    tx.moveCall({
      target: `${vault.packageId}::spending_vault::cancel_spend_intent`,
      arguments: [tx.object(vault.ownerCapId), tx.object(vault.vaultId), tx.pure.id(intentId)],
    });
  }
  return tx;
}
