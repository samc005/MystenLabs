"use client";

import { useState } from "react";
import { buildOwnerActionTx, type OwnerAction } from "@/lib/owner-actions";
import { execute } from "@/lib/onboarding";
import { ownerSigner, OwnerSignerError, startGoogleSignIn, type OwnerKind } from "@/lib/owner-signer";
import { createSuiClient, explorerTxUrl, formatSui } from "@/lib/sui";
import { shortAddress } from "@/lib/display";
import { planDeadlines } from "@/lib/plan";
import { ownerApprovalPayload } from "@/lib/owner-approval";
import { approveProposalWithEnrollment, hashProposal } from "@/lib/passkey";

async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Request failed (${response.status}).`);
  return result;
}

/**
 * After the wallet signs, tell the server so it can verify the transaction on-chain and act on it.
 * Plans and top-up payments carry the passkey approval, which the server checks against the
 * on-chain terms. Returns the payment's digest for a top-up payment.
 */
async function afterSigned(action: OwnerAction, digest: string, approvalId: string): Promise<string | null> {
  if (action.kind === "pay") {
    try {
      const result = await post("/api/payments/approved", { digest, approvalId, note: action.note });
      return typeof result.digest === "string" ? result.digest : null;
    } catch (reason) {
      throw new Error(
        `The payment didn't go out: ${reason instanceof Error ? reason.message : String(reason)} Nothing was sent. ` +
          "You can try again for the next 10 minutes without approving again.",
      );
    }
  }
  if (action.kind !== "plan" && action.kind !== "cancel_plan") return null;
  try {
    await post(
      action.kind === "plan" ? "/api/plans" : "/api/plans/cancel",
      action.kind === "plan" ? { digest, note: action.note, approvalId } : { digest, planId: action.planId },
    );
  } catch (reason) {
    throw new Error(
      `Signed on-chain, but the app could not record it: ${reason instanceof Error ? reason.message : String(reason)} Refresh and check your plans.`,
    );
  }
  return null;
}

interface MeAccount {
  ownerKind: OwnerKind;
  ownerAddress: string;
  vault: { packageId: string; vaultId: string; ownerCapId: string } | null;
}

export function describeOwnerAction(action: OwnerAction): { title: string; detail: string; button: string } {
  if (action.kind === "pay") {
    return {
      title: `Top up and send ${formatSui(BigInt(action.amountMist))} SUI to ${action.recipientLabel}`,
      detail:
        `Moves ${formatSui(BigInt(action.depositMist))} SUI from your wallet into your vault and approves exactly this payment ` +
        `(${action.recipientLabel}, ${formatSui(BigInt(action.amountMist))} SUI${action.note ? `, “${action.note}”` : ""}). ` +
        "Cipher sends it right after. One approval covers both.",
      button: "Approve with passkey and send",
    };
  }
  if (action.kind === "deposit") {
    return {
      title: `Move ${formatSui(BigInt(action.amountMist))} SUI into your vault`,
      detail: "From your wallet into your vault, so Cipher can spend it within your limits.",
      button: "Approve with passkey",
    };
  }
  if (action.kind === "withdraw") {
    return {
      title: `Move ${formatSui(BigInt(action.amountMist))} SUI back to your wallet`,
      detail: "From your vault back into your wallet. Cipher can no longer spend it.",
      button: "Approve with passkey",
    };
  }
  if (action.kind === "plan") {
    const each = formatSui(BigInt(action.amountMist));
    const total = formatSui(BigInt(action.amountMist) * BigInt(action.count));
    const last = new Date(planDeadlines(action).at(-1)!).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const topUp = BigInt(action.depositMist) > 0n ? ` It also moves ${formatSui(BigInt(action.depositMist))} SUI from your wallet into your vault to cover it.` : "";
    return {
      title: `Pay ${action.recipientLabel} ${each} SUI every ${action.every}, ${action.count} times (${total} SUI total)`,
      detail:
        `You approve all ${action.count} payments with this one signature. Cipher can only pay ${action.recipientLabel}, only ${each} SUI each, ` +
        `one per ${action.every}, ending by ${last}. Because you approve them up front, they don't count against your daily or weekly limits. ` +
        `You can cancel the rest anytime.${topUp}`,
      button: "Approve the plan with passkey",
    };
  }
  if (action.kind === "cancel_plan") {
    return {
      title: `Cancel the rest of this plan`,
      detail: `${action.summary} Your wallet withdraws the ${action.intentIds.length} remaining approval${action.intentIds.length === 1 ? "" : "s"}, so they can never run.`,
      button: "Approve with passkey",
    };
  }
  return {
    title: `Make ${action.name} a trusted recipient`,
    detail: `Cipher will be able to pay ${action.name} (${shortAddress(action.address)}) directly, still within your limits.`,
    button: "Approve with passkey",
  };
}

/** Lets the owner's own wallet sign an action Cipher prepared. The server never sees a key. */
export function OwnerActionCard({ action, onDone }: { action: OwnerAction; onDone: () => void }) {
  const [state, setState] = useState<"idle" | "passkey" | "signing" | "sending" | "retry" | "done" | "cancelled">("idle");
  const [digest, setDigest] = useState<string | null>(null);
  /** For a top-up payment: the owner transaction that topped up the vault and approved the payment. */
  const [approvedTx, setApprovedTx] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; signIn: boolean } | null>(null);
  const text = describeOwnerAction(action);
  const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

  /** Sends an approved top-up payment. A retry reuses the same on-chain approval: no new prompt. */
  async function sendApproved(ownerDigest: string, approvalId: string | null) {
    setState("sending");
    try {
      const paid = await afterSigned(action, ownerDigest, approvalId ?? "");
      setDigest(paid);
      setError(null);
      setState("done");
    } catch (reason) {
      setError({ message: message(reason), signIn: false });
      setState("retry");
    }
    onDone();
  }

  async function sign() {
    setState("signing");
    setError(null);
    try {
      const me = (await (await fetch("/api/accounts/me", { cache: "no-store" })).json()) as { account: MeAccount | null };
      if (!me.account?.vault) throw new Error("Your account is not set up yet.");
      // Every vault change starts with the owner's passkey, then the owner's wallet signs.
      setState("passkey");
      const { approvalId } = await approveProposalWithEnrollment(await hashProposal(ownerApprovalPayload(action)));
      setState("signing");
      const signer = await ownerSigner(me.account);
      const tx = buildOwnerActionTx(action, me.account.vault);
      const signed = await execute(createSuiClient(), signer, tx);
      if (action.kind === "pay") {
        setApprovedTx(signed);
        await sendApproved(signed, approvalId);
        return;
      }
      setDigest(signed);
      try {
        await afterSigned(action, signed, approvalId);
      } catch (reason) {
        // Already on-chain: never offer to sign again, which could duplicate it.
        setError({ message: message(reason), signIn: false });
      }
      setState("done");
      onDone();
    } catch (reason) {
      setState("idle");
      setError({ message: message(reason), signIn: reason instanceof OwnerSignerError && reason.code === "zk_expired" });
    }
  }

  return (
    <div className="confirm-card owner-action">
      <strong>{text.title}</strong>
      <p className="muted small">{text.detail}</p>
      {state === "done" && digest && (
        <p className="small">
          {action.kind === "pay" ? "Sent." : "Done."}{" "}
          <a className="receipt-link" href={explorerTxUrl(digest)} target="_blank" rel="noreferrer">
            View receipt ↗
          </a>
        </p>
      )}
      {(state === "retry" || state === "sending") && approvedTx && (
        <p className="small muted">
          Your vault was topped up.{" "}
          <a className="receipt-link" href={explorerTxUrl(approvedTx)} target="_blank" rel="noreferrer">
            Top-up receipt ↗
          </a>
        </p>
      )}
      {state === "cancelled" && <p className="muted small">Cancelled. Nothing changed.</p>}
      {error && (
        <p className="error-text" role="alert">
          {error.message}{" "}
          {error.signIn && (
            <button className="link" onClick={() => void startGoogleSignIn()}>
              Sign in again
            </button>
          )}
        </p>
      )}
      {(state === "retry" || state === "sending") && approvedTx && (
        <div className="actions">
          <button onClick={() => void sendApproved(approvedTx, null)} disabled={state === "sending"}>
            {state === "sending" ? "Sending…" : "Try sending again"}
          </button>
        </div>
      )}
      {(state === "idle" || state === "passkey" || state === "signing") && (
        <div className="actions">
          <button onClick={() => void sign()} disabled={state !== "idle"}>
            {state === "passkey" ? "Confirm with your passkey…" : state === "signing" ? "Waiting for your wallet…" : text.button}
          </button>
          <button className="ghost" onClick={() => setState("cancelled")} disabled={state !== "idle"}>
            Not now
          </button>
        </div>
      )}
    </div>
  );
}
