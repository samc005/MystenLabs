"use client";

import { useCallback, useEffect, useState } from "react";
import { addressUrl, receiptUrl, shortAddress } from "@/lib/display";
import { formatSui } from "@/lib/sui";
import type { ActivityEntry } from "@/lib/server/activity";

const BY_LABEL: Record<ActivityEntry["by"], string> = { you: "You", cipher: "Cipher", "someone else": "Incoming" };

function when(timestamp: string | null): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Recent on-chain activity for the signed-in account. `refreshKey` changes when something just happened. */
export function ActivityPanel({ refreshKey }: { refreshKey: number }) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/activity", { cache: "no-store" });
      const body = (await response.json()) as { entries?: ActivityEntry[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load recent transactions.");
      setEntries(body.entries ?? []);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The indexer trails execution by a moment, so look again shortly after a change.
    void load();
    if (refreshKey === 0) return;
    const timer = window.setTimeout(() => void load(), 4_000);
    return () => window.clearTimeout(timer);
  }, [load, refreshKey]);

  return (
    <section className="card">
      <div className="card-head spread">
        <h2>Recent transactions</h2>
        <button className="secondary small-btn" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      {error && <p className="muted small">{error}</p>}
      {entries && entries.length === 0 && <p className="empty">No transactions yet.</p>}
      {entries && entries.length > 0 && (
        <ul className="activity">
          {entries.map((entry) => (
            <li key={entry.digest} className={entry.success ? undefined : "failed"}>
              <div className="activity-main">
                <span className="activity-title">
                  {entry.title}
                  {!entry.success && " (failed)"}
                </span>
                {entry.note && <span className="activity-note">“{entry.note}”</span>}
                {entry.amountMist && (
                  <span className={`activity-amount ${entry.direction}`}>
                    {entry.direction === "in" ? "+" : entry.direction === "out" ? "−" : ""}
                    {formatSui(BigInt(entry.amountMist))} SUI
                  </span>
                )}
              </div>
              <div className="activity-meta muted small">
                <span>{BY_LABEL[entry.by]}</span>
                {entry.counterparty && (
                  <>
                    {" · "}
                    {entry.direction === "in" ? "from " : "to "}
                    <a href={addressUrl(entry.counterparty.address)} target="_blank" rel="noreferrer" title={entry.counterparty.address}>
                      {entry.counterparty.label ?? <span className="mono">{shortAddress(entry.counterparty.address)}</span>}
                    </a>
                  </>
                )}
                {" · "}
                {when(entry.timestamp)}
                {" · "}
                <a href={receiptUrl(entry.digest)} target="_blank" rel="noreferrer" title={entry.digest}>
                  Receipt ↗
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
