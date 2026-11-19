"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseToMist } from "@mysten/sui/utils";
import {
  createSuiClient,
  explorerAddressUrl,
  FAUCET_PAGE_URL,
  formatSui,
  getSuiBalance,
  NETWORK,
} from "@/lib/sui";
import { loadOrCreateWallet, type DemoWallet } from "@/lib/wallet";
import { createAccount, loadAccount, type OnboardingAccount, type OnboardingStep } from "@/lib/onboarding";
import { DEFAULT_ONBOARDING_POLICY, requiredOwnerBalanceMist, type OnboardingPolicy } from "@/lib/owner-tx";

const STEPS: { id: OnboardingStep; label: string }[] = [
  { id: "check", label: "Checking your wallet balance" },
  { id: "agent", label: "Creating your agent's key (held by the signer, never the browser)" },
  { id: "vault", label: "Creating your vault. Your wallet signs, so you own it" },
  { id: "configure", label: "Authorizing the agent, setting limits, funding the vault" },
  { id: "verify", label: "Verifying everything on-chain" },
];

const shortAddress = (address: string) => `${address.slice(0, 10)}…${address.slice(-6)}`;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function parseRecipients(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export default function Onboarding() {
  const client = useRef(createSuiClient());
  const [owner, setOwner] = useState<DemoWallet | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [account, setAccount] = useState<OnboardingAccount | null>(null);
  const [deposit, setDeposit] = useState(formatSui(DEFAULT_ONBOARDING_POLICY.depositMist));
  const [agentGas, setAgentGas] = useState(formatSui(DEFAULT_ONBOARDING_POLICY.agentGasMist));
  const [dayCap, setDayCap] = useState(formatSui(DEFAULT_ONBOARDING_POLICY.dayCapMist));
  const [weekCap, setWeekCap] = useState(formatSui(DEFAULT_ONBOARDING_POLICY.weekCapMist));
  const [recipients, setRecipients] = useState("");
  const [step, setStep] = useState<OnboardingStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  // undefined while loading, null when signed out.
  const [user, setUser] = useState<{ email: string } | null | undefined>(undefined);

  // The owner key lives in localStorage, so it only exists after mount.
  useEffect(() => {
    setOwner(loadOrCreateWallet("owner"));
    void fetch("/api/auth/session")
      .then((response) => response.json())
      .then((body: { user: { email: string } | null }) => setUser(body.user))
      .catch(() => setUser(null));
    if (new URLSearchParams(window.location.search).get("auth") === "failed") {
      setNotice("Google sign-in did not complete. Try again.");
    }
  }, []);

  async function signOut() {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    setUser(null);
    setAccount(null);
  }

  const refresh = useCallback(async () => {
    if (!owner || !user) return;
    try {
      setBalance(await getSuiBalance(client.current, owner.address));
      setAccount(await loadAccount(owner.address));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [owner, user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function readPolicy(): OnboardingPolicy {
    const depositMist = parseToMist(deposit);
    return {
      ...DEFAULT_ONBOARDING_POLICY,
      depositMist,
      agentGasMist: parseToMist(agentGas),
      dayCapMist: parseToMist(dayCap),
      weekCapMist: parseToMist(weekCap),
      allowedRecipients: parseRecipients(recipients),
    };
  }

  async function create() {
    if (!owner || !user) return;
    setBusy(true);
    setNotice(null);
    try {
      const done = await createAccount({ owner: owner.keypair, policy: readPolicy(), onStep: setStep });
      setAccount(done);
      setStep(null);
      setBalance(await getSuiBalance(client.current, owner.address));
      // Setup is done: hand over to Cipher after a moment, long enough to read the summary.
      window.setTimeout(() => window.location.assign("/chat"), 2_000);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function openFaucet() {
    if (!owner) return;
    await navigator.clipboard.writeText(owner.address).catch(() => undefined);
    window.open(FAUCET_PAGE_URL, "_blank", "noopener");
    setNotice("Address copied. Request testnet SUI on the faucet, then press Refresh.");
  }

  async function backupKey() {
    if (!owner) return;
    await navigator.clipboard.writeText(owner.keypair.getSecretKey());
    setKeyCopied(true);
    window.setTimeout(() => setKeyCopied(false), 2000);
  }

  let required: bigint | null = null;
  try {
    required = requiredOwnerBalanceMist(readPolicy());
  } catch {
    required = null;
  }
  const funded = balance !== null && required !== null && balance >= required;
  const active = account?.status === "active" && account.vault;

  // While waiting on the faucet, keep checking so the Create button enables the moment SUI lands.
  const ready = Boolean(active);
  useEffect(() => {
    if (!owner || !user || ready || funded) return;
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [owner, user, ready, funded, refresh]);

  return (
    <main className="page">
      <header className="masthead">
        <div>
          <Link className="back" href="/">
            ← All demos
          </Link>
          <p className="eyebrow">
            <span className="pill">{NETWORK}</span> Coins here have no value
          </p>
          <h1>Create your account</h1>
          <p className="lede">
            You get your own wallet and your own vault. Your wallet owns the vault and sets its limits. Your AI agent gets
            a separate key that can only spend inside those limits.
          </p>
        </div>
      </header>

      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button className="link" onClick={() => setNotice(null)} aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      )}

      {user === null && (
        <div className="notice" role="status">
          <span>Sign in with Google to create your account.</span>
          <button onClick={() => window.location.assign("/api/auth/google/start")}>Sign in with Google</button>
        </div>
      )}
      {user && (
        <p className="muted small">
          Signed in as {user.email}.{" "}
          <button className="link" onClick={signOut}>
            Sign out
          </button>
        </p>
      )}

      <section className="steps">
        <article className="card">
          <div className="card-head">
            <span className="step">1</span>
            <h2>Your owner wallet</h2>
          </div>
          <p className="muted">
            Generated in this browser. It owns your vault and can change every limit. The secret key never leaves this
            page, and if you lose it you lose control of the vault, so back it up.
          </p>
          <div className="wallet">
            <div>
              <p className="wallet-label">Owner</p>
              {owner ? (
                <a className="mono" href={explorerAddressUrl(owner.address)} target="_blank" rel="noreferrer" title={owner.address}>
                  {shortAddress(owner.address)}
                </a>
              ) : (
                <span className="muted">Creating…</span>
              )}
            </div>
            <div className="wallet-side">
              <span className="balance">{balance === null ? "—" : `${formatSui(balance)} SUI`}</span>
            </div>
          </div>
          <div className="actions">
            <button onClick={openFaucet} disabled={!owner}>
              Copy address and open faucet
            </button>
            <button className="secondary" onClick={() => void refresh()} disabled={!owner}>
              Refresh
            </button>
            <button className="ghost" onClick={backupKey} disabled={!owner}>
              {keyCopied ? "Secret key copied" : "Back up secret key"}
            </button>
          </div>
        </article>

        {!active && (
          <article className="card">
            <div className="card-head">
              <span className="step">2</span>
              <h2>Vault and limits</h2>
            </div>
            <p className="muted">
              The vault holds the money your agent may spend. Your agent cannot exceed these limits, and only your wallet
              can change them.
              {required !== null && ` Needs about ${formatSui(required)} SUI in your wallet.`}
            </p>
            <label className="field narrow">
              <span>Move into vault (SUI)</span>
              <input value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" />
            </label>
            <label className="field narrow">
              <span>Daily cap (SUI)</span>
              <input value={dayCap} onChange={(e) => setDayCap(e.target.value)} inputMode="decimal" />
            </label>
            <label className="field narrow">
              <span>Weekly cap (SUI)</span>
              <input value={weekCap} onChange={(e) => setWeekCap(e.target.value)} inputMode="decimal" />
            </label>
            <label className="field narrow">
              <span>Agent gas (SUI)</span>
              <input value={agentGas} onChange={(e) => setAgentGas(e.target.value)} inputMode="decimal" />
            </label>
            <label className="field">
              <span>Trusted recipients (optional, one address per line)</span>
              <textarea
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                spellCheck={false}
                rows={3}
                placeholder="0x…"
              />
            </label>
            <p className="muted small">
              Your agent can only pay trusted recipients directly. With none listed, every payment needs your approval.
            </p>
            <div className="actions">
              <button onClick={create} disabled={!owner || !user || busy || !funded}>
                {busy ? "Creating…" : "Create my vault"}
              </button>
              {!funded && <span className="muted small">Fund your owner wallet first.</span>}
            </div>
            {step && (
              <ol className="calls">
                {STEPS.map((entry, index) => {
                  const current = STEPS.findIndex((candidate) => candidate.id === step);
                  const state = index < current ? "done" : index === current ? "now" : "todo";
                  return (
                    <li key={entry.id} className={state === "todo" ? "muted" : undefined}>
                      {state === "done" ? "✓ " : state === "now" ? "… " : "  "}
                      {entry.label}
                    </li>
                  );
                })}
              </ol>
            )}
          </article>
        )}

        {active && account.vault && (
          <article className="card">
            <div className="card-head">
              <span className="step">✓</span>
              <h2>Your account is ready</h2>
            </div>
            <div className="receipt">
              <p>
                <strong>Vault</strong>{" "}
                <a className="mono" href={explorerAddressUrl(account.vault.vaultId)} target="_blank" rel="noreferrer">
                  {shortAddress(account.vault.vaultId)}
                </a>
              </p>
              <p>
                <strong>Owner (you)</strong> <span className="mono">{shortAddress(account.ownerAddress)}</span>
              </p>
              <p>
                <strong>Agent</strong> <span className="mono">{shortAddress(account.agentAddress)}</span>
              </p>
            </div>
            <div className="actions">
              <button onClick={() => window.location.assign("/chat")}>Chat with Cipher</button>
            </div>
            <p className="muted small">
              Cipher now works inside this vault. Changing limits and approving payments from your wallet are not built
              yet.
            </p>
          </article>
        )}
      </section>
    </main>
  );
}
