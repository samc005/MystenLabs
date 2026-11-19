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
  // Set when the server says this visitor cannot use chat yet, so we show what to do instead.
  const [gate, setGate] = useState<"sign_in" | "no_account" | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/wallets", { cache: "no-store" });
      const body = (await response.json()) as {
        wallets?: LocalWallet[];
        status?: WalletMcpStatus;
        error?: string;
        code?: string;
      };
      if (!response.ok) {
        if (body.code === "sign_in" || body.code === "no_account") {
          setGate(body.code);
          setError(null);
          return;
        }
        throw new Error(body.error ?? `Request failed (${response.status})`);
      }
      setGate(null);
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
        <Link className="back" href="/settings">
          Account settings →
        </Link>
        <p className="eyebrow">
          <span className="pill">testnet</span> Local only · Cipher (Claude) → wallet-mcp → Sui
        </p>
        <h1>Chat with Cipher</h1>
        <p className="lede">
          Cipher is an assistant powered by Claude. Your message goes to it with the tools listed by the wallet-mcp server. When Cipher calls one, the server
          runs it against the local wallets and the panel on the right updates.
        </p>
      </header>

      {error && (
        <div className="notice" role="status">
          <span>{error}</span>
        </div>
      )}

      {gate ? (
        <div className="notice" role="status">
          <span>
            {gate === "sign_in"
              ? "Sign in with Google to chat with Cipher."
              : "Create your account first. You get your own wallet and vault, and Cipher works inside it."}
          </span>
          <button onClick={() => window.location.assign(gate === "sign_in" ? "/api/auth/google/start" : "/onboarding")}>
            {gate === "sign_in" ? "Sign in with Google" : "Create your account"}
          </button>
        </div>
      ) : (
        <div className="chat-grid">
          <ChatPanel onToolResult={refresh} />
          <div className="side">
            <WalletPanel wallets={wallets} status={status} loading={loading} onRefresh={refresh} />
            <ScriptRunner onFinished={refresh} />
          </div>
        </div>
      )}
    </main>
  );
}
