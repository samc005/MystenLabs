"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { startGoogleSignIn } from "@/lib/owner-signer";

interface Me {
  user: { email: string } | null;
  account: { status: "pending" | "active" } | null;
}

/**
 * The front door. Signed out: one button. Signed in: straight to Cipher if the account is ready,
 * or to wallet setup if it is not.
 */
export default function Home() {
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("auth") === "failed") setFailure(params.get("reason") ?? "unknown");
    void fetch("/api/accounts/me", { cache: "no-store" })
      .then((response) => response.json() as Promise<Me>)
      .then((body) => {
        setMe(body);
        if (body.user) {
          const zkFailed = params.get("zk") === "failed" ? "?zk=failed" : "";
          window.location.replace(body.account?.status === "active" ? `/chat${zkFailed}` : `/onboarding${zkFailed}`);
        }
      })
      .catch(() => setMe({ user: null, account: null }));
  }, []);

  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">
          <span className="pill">testnet</span> Coins here have no value
        </p>
        <h1>Cipher</h1>
        <p className="lede">
          Sign in and you get your own wallet and vault. Cipher, an AI assistant, can then pay people for you, but only
          inside the limits you set. Your wallet keeps the keys to change them.
        </p>
      </header>

      {failure && (
        <div className="notice" role="status">
          <span>Google sign-in did not complete ({failure}). Try again.</span>
        </div>
      )}

      <article className="card">
        {me === undefined && <p className="muted">Loading…</p>}
        {me?.user && <p className="muted">Taking you to Cipher…</p>}
        {me && !me.user && (
          <>
            <div className="choices">
              <div className="choice">
                <h2>New here?</h2>
                <p className="muted">
                  Create a wallet from your Google account. No seed phrase, and it works on any device.
                </p>
                <button onClick={() => void startGoogleSignIn("new")}>Create a new wallet</button>
              </div>
              <div className="choice">
                <h2>Already have a Sui wallet?</h2>
                <p className="muted">
                  Bring your Slush (or other Sui) wallet. Same address, same funds, now with Cipher.
                </p>
                <button className="secondary" onClick={() => void startGoogleSignIn("existing")}>
                  Use my existing wallet
                </button>
              </div>
            </div>
            <p className="muted small">
              Both start with Google sign-in, which keeps your account tied to your email. Already set up?{" "}
              <button className="link" onClick={() => void startGoogleSignIn()}>
                Sign in
              </button>
            </p>
          </>
        )}
      </article>

      {me && !me.user && (
        <p className="muted small">
          Just looking? <Link href="/browser-wallet">Try the browser wallet demo</Link>, which needs no sign-in.
        </p>
      )}
    </main>
  );
}
