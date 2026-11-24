"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityPanel } from "@/components/ActivityPanel";
import { accountLabels } from "@/lib/display";
import { ChatPanel } from "@/components/ChatPanel";
import { ScriptRunner } from "@/components/ScriptRunner";
import { SignOutButton } from "@/components/SignOutButton";
import { WalletPanel } from "@/components/WalletPanel";
import { startGoogleSignIn } from "@/lib/owner-signer";
import type { LocalWallet, WalletMcpStatus } from "@/lib/server/wallet-mcp";
import "./chat.css";

export default function ChatDemo() {
  const [wallets, setWallets] = useState<LocalWallet[]>([]);
  const [status, setStatus] = useState<WalletMcpStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the server says this visitor cannot use chat yet, so we show what to do instead.
  const [gate, setGate] = useState<"sign_in" | "no_account" | null>(null);
  const [contacts, setContacts] = useState<Record<string, string>>({});
  const [activityKey, setActivityKey] = useState(0);
  const labels = useMemo(
    () =>
      accountLabels({
        ownerAddress: wallets.find((w) => w.role === "owner")?.address,
        agentAddress: wallets.find((w) => w.role === "agent")?.address,
        vaultId: wallets.find((w) => w.role === "vault")?.address,
        contacts,
      }),
    [wallets, contacts],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/wallets", { cache: "no-store" });
      const body = (await response.json()) as {
        wallets?: LocalWallet[];
        status?: WalletMcpStatus;
        contacts?: Record<string, string>;
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
      setContacts(body.contacts ?? {});
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
        <p className="small">
          <Link className="back" href="/settings">
            Account settings →
          </Link>{" "}
          <SignOutButton />
        </p>
        <p className="eyebrow">
          <span className="pill">testnet</span> Local only · Cipher (Claude) → wallet-mcp → Sui
        </p>
        <h1>Chat with Cipher</h1>
        <p className="lede">
          Talk to Cipher in your own words. It understands what you want, checks it against your vault rules, and
          shows you the exact transaction before anything is sent. Recent transactions update on the right.
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
          <button onClick={() => (gate === "sign_in" ? void startGoogleSignIn() : window.location.assign("/onboarding"))}>
            {gate === "sign_in" ? "Sign in with Google" : "Create your account"}
          </button>
        </div>
      ) : (
        <div className="chat-grid">
          <ChatPanel
            labels={labels}
            onToolResult={() => {
              void refresh();
              setActivityKey((key) => key + 1);
            }}
          />
          <div className="side">
            <WalletPanel wallets={wallets} status={status} loading={loading} onRefresh={refresh} />
            <ActivityPanel refreshKey={activityKey} />
            <ScriptRunner onFinished={refresh} />
          </div>
        </div>
      )}
    </main>
  );
}
