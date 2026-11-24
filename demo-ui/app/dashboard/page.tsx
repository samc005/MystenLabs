"use client";

import { useCallback, useEffect, useState } from "react";
import { AccountBar } from "@/components/AccountBar";
import { OwnerActionCard } from "@/components/OwnerActionCard";
import { PaymentRequestCard } from "@/components/PaymentRequestCard";
import { addressUrl, receiptUrl, shortAddress } from "@/lib/display";
import type { PaymentRequestView } from "@/lib/payment-request";
import type { PaymentPlan } from "@/lib/server/account-store";
import type { Insights, Period } from "@/lib/server/insights";
import { formatSui } from "@/lib/sui";
import "../chat/chat.css";
import "./dashboard.css";

const PERIODS: { id: Period; label: string }[] = [
  { id: "this_week", label: "7 days" },
  { id: "this_month", label: "30 days" },
  { id: "all_time", label: "12 months" },
];

const sui = (mist: string | bigint) => formatSui(BigInt(mist));

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {sub && <span className="tile-sub">{sub}</span>}
    </div>
  );
}

/** Single-series bar chart: one hue, rounded data-ends, hover tooltip, table view. */
function SpendingChart({ series }: { series: Insights["series"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = series.map((point) => BigInt(point.spentMist));
  const max = values.reduce((a, b) => (b > a ? b : a), 0n);
  const width = 640;
  const height = 180;
  const gap = 2;
  const barWidth = (width - gap * (series.length - 1)) / series.length;
  const scale = (value: bigint) => (max === 0n ? 0 : Number((value * 10_000n) / max) / 10_000) * (height - 8);
  const everyNth = series.length > 12 ? Math.ceil(series.length / 8) : 1;

  return (
    <div className="chart">
      {max === 0n ? (
        <p className="empty">No spending in this period.</p>
      ) : (
        <>
          <p className="chart-axis-note muted small">Peak {sui(max)} SUI</p>
          <svg viewBox={`0 0 ${width} ${height + 22}`} role="img" aria-label="Spending over time" className="bars">
            <line x1={0} x2={width} y1={height} y2={height} className="baseline" />
            {series.map((point, i) => {
              const h = scale(values[i]!);
              const x = i * (barWidth + gap);
              return (
                <g key={point.start} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  {/* Hit target taller than the bar, so small values are easy to hover. */}
                  <rect x={x} y={0} width={barWidth} height={height} className="hit" />
                  {h > 0 && (
                    <g className={hover === i ? "bar active" : "bar"}>
                      {/* Rounded data-end on top, square on the baseline. */}
                      <rect x={x} y={height - h} width={barWidth} height={h} rx={Math.min(4, barWidth / 2, h / 2)} />
                      <rect x={x} y={height - Math.min(h, 4)} width={barWidth} height={Math.min(h, 4)} />
                    </g>
                  )}
                  {i % everyNth === 0 && (
                    <text x={x + barWidth / 2} y={height + 16} className="tick">
                      {point.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {hover !== null && (
            <div className="chart-tooltip" role="status">
              <strong>{series[hover]!.label}</strong> · {sui(series[hover]!.spentMist)} SUI
            </div>
          )}
        </>
      )}
      <details className="table-view">
        <summary>Show as table</summary>
        <table>
          <thead>
            <tr>
              <th>Period</th>
              <th>Spent (SUI)</th>
            </tr>
          </thead>
          <tbody>
            {series.map((point) => (
              <tr key={point.start}>
                <td>{point.label}</td>
                <td>{sui(point.spentMist)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function PlanRow({ plan, onChanged }: { plan: PaymentPlan; onChanged: () => void }) {
  const [cancelling, setCancelling] = useState(false);
  const paid = plan.payments.filter((p) => p.status === "paid").length;
  const remaining = plan.payments.filter((p) => p.status === "scheduled");
  const next = remaining[0];
  const problem = remaining.find((p) => p.error);
  const who = shortAddress(plan.recipient);
  const summary = `${sui(plan.amountMist)} SUI to ${who} every ${plan.every}`;
  return (
    <li className="plan">
      <div className="plan-main">
        <span>
          <strong>{sui(plan.amountMist)} SUI</strong> every {plan.every} to{" "}
          <a href={addressUrl(plan.recipient)} target="_blank" rel="noreferrer" className="mono">
            {who}
          </a>
          {plan.note && <span className="muted"> · {plan.note}</span>}
        </span>
        <span className="muted small">
          {paid}/{plan.count} paid
        </span>
      </div>
      <div className="plan-dots" aria-label={`${paid} of ${plan.count} payments made`}>
        {plan.payments.map((payment) =>
          payment.digest ? (
            <a key={payment.intentId} className={`dot-step ${payment.status}`} href={receiptUrl(payment.digest)} target="_blank" rel="noreferrer" title={`Paid · receipt`} />
          ) : (
            <span key={payment.intentId} className={`dot-step ${payment.status}`} title={`${payment.status} · due ${new Date(payment.dueAt).toLocaleString()}`} />
          ),
        )}
      </div>
      <p className="muted small">
        {next ? `Next payment ${new Date(next.dueAt) <= new Date() ? "is due now" : `on ${new Date(next.dueAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`}.` : "Finished."}
        {problem && <span className="error-text"> Last try failed: {problem.error}</span>}
      </p>
      {remaining.length > 0 && !cancelling && (
        <button className="link" onClick={() => setCancelling(true)}>
          Cancel remaining payments
        </button>
      )}
      {cancelling && (
        <OwnerActionCard
          action={{ kind: "cancel_plan", planId: plan.id, intentIds: remaining.map((p) => p.intentId), summary: `${summary}: ${remaining.length} left.` }}
          onDone={onChanged}
        />
      )}
    </li>
  );
}

interface Holdings {
  walletMist: string;
  vaultMist: string;
  stakedMist: string;
  stakes: number;
  maxStakedMist: string | null;
  tradingMist: string;
  stakingOn: boolean;
  tradingOn: boolean;
}

export default function Dashboard() {
  const [period, setPeriod] = useState<Period>("this_week");
  const [insights, setInsights] = useState<Insights | null>(null);
  const [plans, setPlans] = useState<PaymentPlan[]>([]);
  const [requests, setRequests] = useState<PaymentRequestView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [holdings, setHoldings] = useState<Holdings | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [i, p, r, h] = await Promise.all([
        fetch(`/api/insights?period=${period}`, { cache: "no-store" }),
        fetch("/api/plans", { cache: "no-store" }),
        fetch("/api/requests", { cache: "no-store" }),
        fetch("/api/holdings", { cache: "no-store" }),
      ]);
      setHoldings(h.ok ? ((await h.json()) as Holdings) : null);
      if (i.status === 401 || i.status === 403) return window.location.replace("/");
      const insightsBody = (await i.json()) as { insights?: Insights; error?: string };
      if (!i.ok || !insightsBody.insights) throw new Error(insightsBody.error ?? "Could not load insights.");
      setInsights(insightsBody.insights);
      setPlans(((await p.json()) as { plans?: PaymentPlan[] }).plans ?? []);
      setRequests(((await r.json()) as { requests?: PaymentRequestView[] }).requests ?? []);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  async function cancelRequest(id: string) {
    // The local-only guard requires a JSON body on every non-GET request.
    await fetch(`/api/requests?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" });
    await load();
  }

  const openRequests = requests.filter((r) => r.status === "open");
  const pastRequests = requests.filter((r) => r.status !== "open").slice(0, 5);

  return (
    <main className="page wide">
      <header className="masthead">
        <AccountBar links={[{ href: "/chat", label: "Chat" }, { href: "/settings", label: "Account settings" }]} />
        <h1>Dashboard</h1>
        <p className="lede">Where your money went, what's scheduled, and who owes you. Read from the chain.</p>
      </header>

      {error && (
        <div className="notice" role="alert">
          <span>{error}</span>
        </div>
      )}

      <div className="filter-row" role="tablist" aria-label="Period">
        {PERIODS.map((p) => (
          <button key={p.id} className={period === p.id ? undefined : "secondary"} onClick={() => setPeriod(p.id)} aria-selected={period === p.id}>
            {p.label}
          </button>
        ))}
        <button className="ghost small-btn" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {holdings && (
        <section className="tiles" aria-label="Where your SUI is">
          <Tile label="In your wallet" value={`${sui(holdings.walletMist)} SUI`} />
          <Tile label="In your vault" value={`${sui(holdings.vaultMist)} SUI`} sub="What Cipher can spend" />
          <Tile
            label="Staked"
            value={`${sui(holdings.stakedMist)} SUI`}
            sub={
              holdings.stakingOn
                ? `${holdings.stakes} stake${holdings.stakes === 1 ? "" : "s"}${holdings.maxStakedMist ? `, up to ${sui(holdings.maxStakedMist)} SUI allowed` : ""}`
                : "Staking is off"
            }
          />
          <Tile label="Set aside for swaps" value={`${sui(holdings.tradingMist)} SUI`} sub={holdings.tradingOn ? "Swaps are on" : "Swaps are off"} />
        </section>
      )}

      {insights && (
        <>
          <section className="tiles">
            <Tile label="Spent" value={`${sui(insights.spentMist)} SUI`} sub={`${insights.payments} payment${insights.payments === 1 ? "" : "s"}`} />
            <Tile label="Cipher paid for you" value={`${sui(insights.spentByCipherMist)} SUI`} />
            <Tile label="You sent yourself" value={`${sui(insights.spentByYouMist)} SUI`} />
            <Tile label="Received" value={`${sui(insights.receivedMist)} SUI`} />
          </section>

          <section className="dash-grid">
            <article className="card">
              <div className="card-head">
                <h2>Spending</h2>
              </div>
              <SpendingChart series={insights.series} />
            </article>

            <article className="card">
              <div className="card-head">
                <h2>Who you pay most</h2>
              </div>
              {insights.topRecipients.length === 0 && <p className="empty">Nobody yet.</p>}
              <ul className="rank">
                {insights.topRecipients.map((r) => {
                  const share = Number((BigInt(r.totalMist) * 1000n) / BigInt(insights.topRecipients[0]!.totalMist)) / 10;
                  return (
                    <li key={r.address}>
                      <div className="rank-row">
                        <a href={addressUrl(r.address)} target="_blank" rel="noreferrer" title={r.address}>
                          {r.label ?? <span className="mono">{shortAddress(r.address)}</span>}
                        </a>
                        <span>
                          {sui(r.totalMist)} SUI <span className="muted small">· {r.count}×</span>
                        </span>
                      </div>
                      <div className="rank-track">
                        <div className="rank-bar" style={{ width: `${share}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </article>
          </section>
        </>
      )}

      <section className="dash-grid">
        <article className="card">
          <div className="card-head">
            <h2>Payment plans</h2>
          </div>
          {plans.length === 0 && (
            <p className="empty">
              No plans. Try in chat: &ldquo;pay Friend 0.05 every day for 5 days&rdquo;.
            </p>
          )}
          <ul className="plans">
            {plans.map((plan) => (
              <PlanRow key={plan.id} plan={plan} onChanged={() => void load()} />
            ))}
          </ul>
        </article>

        <article className="card">
          <div className="card-head">
            <h2>Payment requests</h2>
          </div>
          {requests.length === 0 && (
            <p className="empty">
              No requests. Try in chat: &ldquo;request 0.05 sui from Sam for pizza&rdquo;.
            </p>
          )}
          {openRequests.map((request) => (
            <div key={request.id}>
              <PaymentRequestCard request={request} />
              <button className="link small" onClick={() => void cancelRequest(request.id)}>
                Cancel request
              </button>
            </div>
          ))}
          {pastRequests.map((request) => (
            <PaymentRequestCard key={request.id} request={request} compact />
          ))}
        </article>
      </section>

      {insights && insights.notes.length > 0 && (
        <article className="card">
          <div className="card-head">
            <h2>Notes</h2>
          </div>
          <ul className="activity">
            {insights.notes.map((note) => (
              <li key={note.digest}>
                <div className="activity-main">
                  <span className="activity-title">{note.note}</span>
                  {note.amountMist && <span className="activity-amount">{sui(note.amountMist)} SUI</span>}
                </div>
                <div className="activity-meta muted small">
                  {note.timestamp ? new Date(note.timestamp).toLocaleDateString() : ""} ·{" "}
                  <a href={receiptUrl(note.digest)} target="_blank" rel="noreferrer">
                    Receipt ↗
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </article>
      )}
    </main>
  );
}
