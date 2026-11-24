// What the owner's passkey approves before their wallet signs a vault change. The browser hashes
// this payload with the passkey challenge; for plans and top-up payments the server rebuilds the
// same payload from the on-chain transaction and refuses to act unless the approval matches.
// Pure and shared by browser and server, so both sides hash exactly the same JSON.

import type { OwnerAction } from "./owner-actions";

/** A one-off payment the owner approved (top up and send). Rebuilt by the server from chain events. */
export function paymentApproval(recipient: string, amountMist: string) {
  return { action: "owner-approved-payment", recipient: recipient.toLowerCase(), amountMist };
}

/** A payment plan. `every` is left out because the server infers it from the deadlines. */
export function planApproval(recipient: string, amountMist: string, count: number) {
  return { action: "owner-approved-plan", recipient: recipient.toLowerCase(), amountMist, count };
}

/** A change to the vault's spending permissions from Settings. */
export function policyApproval(vaultId: string) {
  return { action: "owner-policy-update", vaultId: vaultId.toLowerCase() };
}

export function ownerApprovalPayload(action: OwnerAction): Record<string, unknown> {
  switch (action.kind) {
    case "pay":
      return paymentApproval(action.recipient, action.amountMist);
    case "plan":
      return planApproval(action.recipient, action.amountMist, action.count);
    case "deposit":
    case "withdraw":
      return { action: `owner-${action.kind}`, amountMist: action.amountMist };
    case "trust":
      return { action: "owner-trust", address: action.address.toLowerCase() };
    case "cancel_plan":
      return { action: "owner-cancel-plan", planId: action.planId, intentIds: action.intentIds };
  }
}
