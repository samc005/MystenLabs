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
  | { kind: "cancel_plan"; planId: string; intentIds: string[]; summary: string };

const MODULE = "spending_vault";

export interface VaultRef {
  packageId: string;
  vaultId: string;
  ownerCapId: string;
}

/** The transaction for an owner action. Pure, so it is unit-tested. */
export function buildOwnerActionTx(action: OwnerAction, vault: VaultRef): Transaction {
  if (action.kind === "plan") return buildPlanTx(action, vault);
  if (action.kind === "cancel_plan") return buildCancelPlanTx(action.intentIds, vault);
  const tx = new Transaction();
  const call = (name: string) => `${vault.packageId}::${MODULE}::${name}`;
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
