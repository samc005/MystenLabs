// Owner actions Cipher can PREPARE in chat but never perform. The owner's own wallet signs each one
// in the browser (zkLogin, a connected wallet like Slush, or a legacy browser key). The server only
// describes the action; it cannot sign it.

import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { buildCancelPlanTx, buildPlanTx, type PlanInput } from "./plan";

export type OwnerAction =
  | { kind: "deposit"; amountMist: string }
  | { kind: "withdraw"; amountMist: string }
  | { kind: "trust"; address: string; name: string }
  | ({ kind: "plan"; recipientLabel: string; note: string | null } & PlanInput)
  | { kind: "cancel_plan"; planId: string; intentIds: string[]; summary: string }
  /**
   * The vault is short for a payment: one owner transaction moves the difference into the vault
   * and approves exactly this payment (recipient and amount fixed on-chain). The server then
   * sends it once it has checked the same passkey approval.
   */
  | { kind: "pay"; recipient: string; recipientLabel: string; amountMist: string; depositMist: string; note: string | null };

const MODULE = "spending_vault";
/** How long the agent has to send an approved top-up payment. */
export const PAY_APPROVAL_WINDOW_MS = 10 * 60_000;

export interface VaultRef {
  packageId: string;
  vaultId: string;
  ownerCapId: string;
}

/** The transaction for an owner action. Pure, so it is unit-tested. */
export function buildOwnerActionTx(action: OwnerAction, vault: VaultRef, now = Date.now()): Transaction {
  if (action.kind === "plan") return buildPlanTx(action, vault);
  if (action.kind === "cancel_plan") return buildCancelPlanTx(action.intentIds, vault);
  const tx = new Transaction();
  const call = (name: string) => `${vault.packageId}::${MODULE}::${name}`;
  if (action.kind === "pay") {
    const amount = BigInt(action.amountMist);
    const deposit = BigInt(action.depositMist);
    if (!/^0x[0-9a-f]{64}$/.test(action.recipient)) throw new Error("Recipient must be a full address.");
    if (amount <= 0n || deposit < 0n) throw new Error("Amount must be more than zero.");
    if (deposit > 0n) {
      tx.moveCall({ target: call("deposit"), arguments: [tx.object(vault.vaultId), coinWithBalance({ balance: deposit })(tx)] });
    }
    tx.moveCall({
      target: call("create_spend_intent"),
      arguments: [
        tx.object(vault.ownerCapId),
        tx.object(vault.vaultId),
        tx.pure.address(action.recipient),
        tx.pure.u64(amount),
        tx.pure.u64(BigInt(now + PAY_APPROVAL_WINDOW_MS)),
        tx.object.clock(),
      ],
    });
    return tx;
  }
  if (action.kind === "deposit") {
    const amount = BigInt(action.amountMist);
    if (amount <= 0n) throw new Error("Amount must be more than zero.");
    tx.moveCall({ target: call("deposit"), arguments: [tx.object(vault.vaultId), coinWithBalance({ balance: amount })(tx)] });
  } else if (action.kind === "withdraw") {
    const amount = BigInt(action.amountMist);
    if (amount <= 0n) throw new Error("Amount must be more than zero.");
    tx.moveCall({
      target: call("withdraw"),
      arguments: [tx.object(vault.ownerCapId), tx.object(vault.vaultId), tx.pure.u64(amount)],
    });
  } else {
    tx.moveCall({
      target: call("allow_recipient"),
      arguments: [tx.object(vault.ownerCapId), tx.object(vault.vaultId), tx.pure.address(action.address)],
    });
  }
  return tx;
}
