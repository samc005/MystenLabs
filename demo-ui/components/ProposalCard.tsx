"use client";
import { approveProposal, hashProposal } from "@/lib/passkey";

import { useCallback, useEffect, useState } from "react";
import { explorerTx, formatUnits, isSpendProposal, type Proposal } from "@/lib/proposals";

interface Props {
  id: string;
  /** Called once, right after the owner's approval is confirmed on-chain. */
  onApproved: (proposal: Proposal) => void;
  onRejected: (proposal: Proposal) => void;
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const STATUS_LABEL: Record<Proposal["status"], string> = {
  pending: "Waiting for your approval",
  approved: "Approved on-chain",
  executed: "Executed",
  rejected: "Rejected",
  expired: "Expired",
  failed: "Failed",
};

/**
 * The approval card. Everything shown here comes from the stored proposal, which the server
 * built from a live quote. It is not text written by the model, so the model cannot
 * misstate what you are approving.
 */
export function ProposalCard({ id, onApproved, onRejected }: Props) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acting, setActing] = useState<"approve" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/proposals/${id}`, { cache: "no-store" });
      const body = (await response.json()) as { proposal?: Proposal; error?: string };
      if (!response.ok || !body.proposal) throw new Error(body.error ?? `Request failed (${response.status})`);
      setProposal(body.proposal);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Tick the countdown, and keep the status fresh while the trade is still in flight.
  const live = proposal?.status === "pending" || proposal?.status === "approved";
  useEffect(() => {
    if (!live) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => void load(), 4000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [live, load]);

  async function decide(action: "approve" | "reject") {
    setActing(action);
    setActionError(null);
    try {
      const { approvalId } = await approveProposal(await hashProposal({ action: "proposal-decision", id, decision: action, proposal }));
      const response = await fetch(`/api/proposals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, approvalId }),
      });
      const body = (await response.json()) as { proposal?: Proposal; error?: string };
      if (!response.ok || !body.proposal) throw new Error(body.error ?? `Request failed (${response.status})`);
      setProposal(body.proposal);
      if (action === "approve") onApproved(body.proposal);
      else onRejected(body.proposal);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      void load();
    } finally {
      setActing(null);
    }
  }

  if (loadError && !proposal) return <div className="proposal-card error">Could not load proposal {id}: {loadError}</div>;
  if (!proposal) return <div className="proposal-card muted">Loading proposal…</div>;

  const p = proposal;
  const remaining =
    p.status === "pending" ? p.approvalDeadlineMs - now : p.status === "approved" && p.intentExpiryMs ? p.intentExpiryMs - now : null;
  const spend = isSpendProposal(p);
  const auto = !spend && p.auto === true;
  const approvalLabel = p.status === "pending" ? "Approve within" : "Cipher must run it within";

  const actions = (
    <div className="proposal-actions">
      <button onClick={() => void decide("approve")} disabled={acting !== null}>
        {acting === "approve" ? "Signing…" : spend ? "Approve payment" : "Approve trade"}
      </button>
      <button className="ghost" onClick={() => void decide("reject")} disabled={acting !== null}>
        {acting === "reject" ? "Rejecting…" : "Reject"}
      </button>
    </div>
  );

  const links = (
    <>
      {p.approvalDigest && (
        <a href={explorerTx(p.approvalDigest)} target="_blank" rel="noreferrer">
          approval tx
        </a>
      )}
      {spend && p.spendDigest && (
        <a href={explorerTx(p.spendDigest)} target="_blank" rel="noreferrer">
          payment tx
        </a>
      )}
      {!spend && p.swapDigest && (
        <a href={explorerTx(p.swapDigest)} target="_blank" rel="noreferrer">
          swap tx
        </a>
      )}
    </>
  );
  const hasLinks = Boolean(p.approvalDigest || (spend ? p.spendDigest : p.swapDigest));

  return (
    <div className={`proposal-card ${p.status}`}>
      <div className="proposal-head">
        <span className="tool-badge">{spend ? "Payment approval" : auto ? "Trade (standing rule)" : "Trade proposal"}</span>
        <span className={`status-pill ${p.status}`}>
          {auto && p.status === "approved" ? "Covered by your standing rule" : STATUS_LABEL[p.status]}
        </span>
      </div>

      {spend ? (
        <>
          <div className="proposal-trade">
            <span className="proposal-sell">{formatUnits(p.amountMist, 9)} SUI</span>
            <span className="proposal-arrow" aria-hidden>→</span>
            <span className="proposal-buy">{p.recipient}</span>
          </div>
          <dl className="proposal-facts">
            <dt>Needs approval because</dt>
            <dd>{p.reason}</dd>
            {remaining !== null && (
              <>
                <dt>{approvalLabel}</dt>
                <dd>{mmss(remaining)}</dd>
              </>
            )}
          </dl>
          {p.status === "pending" && (
            <>
              <p className="proposal-note">
                Approving signs an on-chain approval from your owner key for exactly this recipient and amount. Cipher can use it once and cannot change either.
              </p>
              {actions}
            </>
          )}
          {p.status === "approved" && <p className="proposal-note">Approved. Cipher can now make this payment.</p>}
          {p.status === "executed" && <p className="proposal-note">Paid from the vault.</p>}
        </>
      ) : (
        <>
          <div className="proposal-trade">
            <span className="proposal-sell">{`${formatUnits(p.amountIn, p.inDecimals)} ${p.inSymbol}`}</span>
            <span className="proposal-arrow" aria-hidden>→</span>
            <span className="proposal-buy">at least {`${formatUnits(p.minOut, p.outDecimals)} ${p.outSymbol}`}</span>
          </div>
          <dl className="proposal-facts">
            <dt>Quoted</dt>
            <dd>{`${formatUnits(p.quotedOut, p.outDecimals)} ${p.outSymbol}`} (fee included)</dd>
            <dt>Slippage allowed</dt>
            <dd>{p.slippageBps / 100}%</dd>
            <dt>Venue</dt>
            <dd>{p.dex}</dd>
            {p.ruleNote && (
              <>
                <dt>Standing rule not used</dt>
                <dd>{p.ruleNote}</dd>
              </>
            )}
            {remaining !== null && (
              <>
                <dt>{approvalLabel}</dt>
                <dd>{mmss(remaining)}</dd>
              </>
            )}
          </dl>
          {p.status === "pending" && (
            <>
              <p className="proposal-note">
                Approving signs an on-chain intent from your owner key for exactly this trade. Cipher can run it once and cannot change the amounts. If the swap
                returns less than the minimum, the contract rejects it.
              </p>
              {actions}
            </>
          )}
          {p.status === "approved" && (
            <p className="proposal-note">
              {auto
                ? "No approval needed: your standing trade rule covers this swap. The contract re-checks the rule and the price floor when it runs."
                : "Approved. Cipher can now run this trade."}
            </p>
          )}
          {p.status === "executed" && p.amountOut && (
            <p className="proposal-note">
              Received {formatUnits(p.amountOut, p.outDecimals)} {p.outSymbol}, now in the vault&apos;s trading sleeve.
            </p>
          )}
        </>
      )}
      {p.status === "approved" && (
        <button onClick={() => onApproved(p)} disabled={acting !== null}>
          Prepare approved transaction
        </button>
      )}
      {p.status === "expired" && <p className="proposal-note">The approval window closed. Ask Cipher for a new proposal.</p>}

      {hasLinks && <p className="proposal-links">{links}</p>}
      {actionError && <p className="proposal-error">{actionError}</p>}
      {p.error && p.status !== "executed" && <p className="proposal-error">{p.error}</p>}
    </div>
  );
}
