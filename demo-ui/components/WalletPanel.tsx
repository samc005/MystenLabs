"use client";

import { useEffect, useRef, useState } from "react";
import { explorerAddressUrl, formatSui } from "@/lib/sui";
import type { LocalWallet, WalletMcpStatus } from "@/lib/server/wallet-mcp";

interface Props {
  wallets: LocalWallet[];
  status: WalletMcpStatus | null;
  loading: boolean;
  onRefresh: () => void;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

const ROLE_LABEL: Record<LocalWallet["role"], string> = {
  vault: "Vault (what Cipher can spend)",
  owner: "Owner (you)",
  agent: "Agent (Cipher's key, pays gas)",
};

function explorerUrl(wallet: LocalWallet): string {
  return wallet.kind === "object" ? `https://suiscan.xyz/testnet/object/${wallet.address}` : explorerAddressUrl(wallet.address);
}

/** Signed change in SUI since the previous refresh, per wallet address. */
function useBalanceChanges(wallets: LocalWallet[]): Record<string, bigint> {
  const previous = useRef<Record<string, string | null>>({});
  const [changes, setChanges] = useState<Record<string, bigint>>({});

  useEffect(() => {
    const next: Record<string, bigint> = {};
    for (const wallet of wallets) {
      const before = previous.current[wallet.address];
      if (before != null && wallet.balanceMist != null && before !== wallet.balanceMist) {
        next[wallet.address] = BigInt(wallet.balanceMist) - BigInt(before);
      }
      previous.current[wallet.address] = wallet.balanceMist;
    }
    if (Object.keys(next).length === 0) return;
    setChanges(next);
    const timer = window.setTimeout(() => setChanges({}), 6000);
    return () => window.clearTimeout(timer);
  }, [wallets]);

  return changes;
}

export function WalletPanel({ wallets, status, loading, onRefresh }: Props) {
  const changes = useBalanceChanges(wallets);

  return (
    <section className="card">
      <div className="card-head spread">
        <h2>Your account</h2>
        <button className="secondary small-btn" onClick={onRefresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p className="muted">
        Cipher spends from your vault, within the limits your owner wallet set. The agent key only pays gas. Balances
        come from testnet.
      </p>

      {wallets.length === 0 && !loading && <p className="empty">No account loaded yet.</p>}

      {wallets.map((wallet) => {
        const change = changes[wallet.address];
        return (
          <div key={wallet.role} className={change !== undefined ? "wallet changed" : "wallet"}>
            <div>
              <p className="wallet-label">{ROLE_LABEL[wallet.role]}</p>
              <a className="mono" href={explorerUrl(wallet)} target="_blank" rel="noreferrer" title={wallet.address}>
                {shortAddress(wallet.address)}
              </a>
            </div>
            <div className="wallet-side">
              {change !== undefined && (
                <span className={change > 0n ? "delta up" : "delta down"}>
                  {change > 0n ? "+" : ""}
                  {formatSui(change)}
                </span>
              )}
              <span className="balance">
                {wallet.balanceMist === null ? "—" : `${formatSui(BigInt(wallet.balanceMist))} SUI`}
              </span>
            </div>
          </div>
        );
      })}

      {status && (
        <ul className="checks">
          <li className={status.installed ? "pass" : "fail"}>wallet-mcp dependencies installed</li>
          <li className={status.built ? "pass" : "fail"}>wallet-mcp MCP server built</li>
          <li className={status.apiKey ? "pass" : "fail"}>
            Natural-language translation {status.apiKey ? "configured" : "needs ANTHROPIC_API_KEY; explicit commands still work"}
          </li>
        </ul>
      )}
    </section>
  );
}
