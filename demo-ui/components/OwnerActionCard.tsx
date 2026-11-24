"use client";

import { useState } from "react";
import { buildOwnerActionTx, type OwnerAction } from "@/lib/owner-actions";
import { execute } from "@/lib/onboarding";
import { ownerSigner, OwnerSignerError, startGoogleSignIn, type OwnerKind } from "@/lib/owner-signer";
import { createSuiClient, explorerTxUrl, formatSui } from "@/lib/sui";
import { shortAddress } from "@/lib/display";

interface MeAccount {
  ownerKind: OwnerKind;
  ownerAddress: string;
  vault: { packageId: string; vaultId: string; ownerCapId: string } | null;
}

export function describeOwnerAction(action: OwnerAction): { title: string; detail: string; button: string } {
  if (action.kind === "deposit") {
    return {
      title: `Move ${formatSui(BigInt(action.amountMist))} SUI into your vault`,
      detail: "From your wallet into your vault, so Cipher can spend it within your limits.",
      button: "Sign with my wallet",
    };
  }
  if (action.kind === "withdraw") {
    return {
      title: `Move ${formatSui(BigInt(action.amountMist))} SUI back to your wallet`,
      detail: "From your vault back into your wallet. Cipher can no longer spend it.",
      button: "Sign with my wallet",
    };
  }
  return {
    title: `Make ${action.name} a trusted recipient`,
    detail: `Cipher will be able to pay ${action.name} (${shortAddress(action.address)}) directly, still within your limits.`,
    button: "Sign with my wallet",
  };
}

/** Lets the owner's own wallet sign an action Cipher prepared. The server never sees a key. */
export function OwnerActionCard({ action, onDone }: { action: OwnerAction; onDone: () => void }) {
  const [state, setState] = useState<"idle" | "signing" | "done" | "cancelled">("idle");
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; signIn: boolean } | null>(null);
  const text = describeOwnerAction(action);

  async function sign() {
    setState("signing");
    setError(null);
    try {
      const me = (await (await fetch("/api/accounts/me", { cache: "no-store" })).json()) as { account: MeAccount | null };
      if (!me.account?.vault) throw new Error("Your account is not set up yet.");
      const signer = await ownerSigner(me.account);
      const tx = buildOwnerActionTx(action, me.account.vault);
      setDigest(await execute(createSuiClient(), signer, tx));
      setState("done");
      onDone();
    } catch (reason) {
      setState("idle");
      setError({
        message: reason instanceof Error ? reason.message : String(reason),
        signIn: reason instanceof OwnerSignerError && reason.code === "zk_expired",
      });
    }
  }

  return (
    <div className="confirm-card owner-action">
      <strong>{text.title}</strong>
      <p className="muted small">{text.detail}</p>
      {state === "done" && digest && (
        <p className="small">
          Done.{" "}
          <a className="receipt-link" href={explorerTxUrl(digest)} target="_blank" rel="noreferrer">
            View receipt ↗
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
      {(state === "idle" || state === "signing") && (
        <div className="actions">
          <button onClick={() => void sign()} disabled={state === "signing"}>
            {state === "signing" ? "Waiting for your wallet…" : text.button}
          </button>
          <button className="ghost" onClick={() => setState("cancelled")} disabled={state === "signing"}>
            Not now
          </button>
        </div>
      )}
    </div>
  );
}
