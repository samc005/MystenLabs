"use client";

import { useCallback, useEffect, useState } from "react";
import { parseToMist } from "@mysten/sui/utils";
import { formatSui } from "@/lib/sui";
import type { OwnerAction } from "@/lib/owner-actions";
import { OwnerActionCard } from "./OwnerActionCard";

/** Move money between your wallet and your vault. Your wallet signs; Cipher is not involved. */
export function VaultMoneyCard({ onChanged }: { onChanged: () => void }) {
  const [balances, setBalances] = useState<{ owner: string | null; vault: string | null } | null>(null);
  const [amount, setAmount] = useState("");
  const [action, setAction] = useState<OwnerAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A new key per request, so each Add/Withdraw click gets a fresh signing card.
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async () => {
    const body = (await (await fetch("/api/wallets", { cache: "no-store" })).json()) as {
      wallets?: { role: string; balanceMist: string | null }[];
    };
    const find = (role: string) => body.wallets?.find((wallet) => wallet.role === role)?.balanceMist ?? null;
    setBalances({ owner: find("owner"), vault: find("vault") });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function start(kind: "deposit" | "withdraw") {
    setError(null);
    try {
      const mist = parseToMist(amount.trim());
      if (mist <= 0n) throw new Error();
      setAction({ kind, amountMist: mist.toString() });
      setAttempt((n) => n + 1);
    } catch {
      setError("Enter an amount in SUI, like 0.5.");
    }
  }

  const show = (mist: string | null | undefined) => (mist == null ? "—" : `${formatSui(BigInt(mist))} SUI`);

  return (
    <article className="card">
      <div className="card-head">
        <h2>Vault money</h2>
      </div>
      <p className="muted">
        Cipher can only spend what is in your vault. Add money to let it do more, or move money back to your wallet.
      </p>
      <div className="wallet">
        <div>
          <p className="wallet-label">Your wallet</p>
          <span className="balance">{show(balances?.owner)}</span>
        </div>
        <div className="wallet-side">
          <p className="wallet-label">Your vault</p>
          <span className="balance">{show(balances?.vault)}</span>
        </div>
      </div>
      <div className="actions">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="Amount in SUI" />
        <button onClick={() => start("deposit")} disabled={!amount.trim()}>
          Add to vault
        </button>
        <button className="secondary" onClick={() => start("withdraw")} disabled={!amount.trim()}>
          Withdraw to wallet
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {action && (
        <OwnerActionCard
          key={attempt}
          action={action}
          onDone={() => {
            setAmount("");
            void load();
            onChanged();
          }}
        />
      )}
    </article>
  );
}
