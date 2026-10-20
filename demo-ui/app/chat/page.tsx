"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ChatPanel } from "@/components/ChatPanel";
import { ScriptRunner } from "@/components/ScriptRunner";
import { WalletPanel } from "@/components/WalletPanel";
import type { LocalWallet, WalletMcpStatus } from "@/lib/server/wallet-mcp";
import "./chat.css";

export default function ChatDemo() {
  const [wallets, setWallets] = useState<LocalWallet[]>([]);
  const [status, setStatus] = useState<WalletMcpStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/wallets", { cache: "no-store" });
      const body = (await response.json()) as { wallets?: LocalWallet[]; status?: WalletMcpStatus; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
      setWallets(body.wallets ?? []);
      setStatus(body.status ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <main className="page wide">
      <header className="masthead">
        <Link className="back" href="/">
          ← All demos
        </Link>
        <p className="eyebrow">
          <span className="pill">testnet</span> Local only · Claude → wallet-mcp → Sui
        </p>
        <h1>Chat with your wallet</h1>
        <p className="lede">
          Your message goes to Claude with the tools listed by the wallet-mcp server. When Claude calls one, the server
          runs it against the local wallets and the panel on the right updates.
        </p>
      </header>

      {error && (
        <div className="notice" role="status">
          <span>{error}</span>
        </div>
      )}

      <div className="chat-grid">
        <ChatPanel onToolResult={refresh} />
        <div className="side">
          <WalletPanel wallets={wallets} status={status} loading={loading} onRefresh={refresh} />
          <ScriptRunner onFinished={refresh} />
        </div>
      </div>
    </main>
  );
}
