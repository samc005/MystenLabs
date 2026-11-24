"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseToMist } from "@mysten/sui/utils";
import type { Signer } from "@mysten/sui/cryptography";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  createSuiClient,
  explorerAddressUrl,
  FAUCET_PAGE_URL,
  formatSui,
  getSuiBalance,
  NETWORK,
} from "@/lib/sui";
import { loadWallet } from "@/lib/wallet";
import { createAccount, findExistingVault, type OnboardingAccount, type OnboardingStep } from "@/lib/onboarding";
import { DEFAULT_ONBOARDING_POLICY, requiredOwnerBalanceMist, type OnboardingPolicy } from "@/lib/owner-tx";
import {
  connectWallet,
  listSuiWallets,
  onWalletsChanged,
  ownerSigner,
  signerForWalletAccount,
  signMessageWithBrowserKey,
  signMessageWithWallet,
  startGoogleSignIn,
  type OwnerKind,
} from "@/lib/owner-signer";

const STEPS: { id: OnboardingStep; label: string }[] = [
  { id: "check", label: "Checking your wallet balance" },
  { id: "agent", label: "Creating your agent's key (held by the signer, never the browser)" },
  { id: "vault", label: "Finding or creating your vault. Your wallet signs, so you own it" },
  { id: "configure", label: "Authorizing the agent and applying your limits" },
  { id: "verify", label: "Verifying everything on-chain" },
];

const shortAddress = (address: string) => `${address.slice(0, 8)}…${address.slice(-6)}`;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface SessionInfo {
  user: { email: string; name: string | null; zkAddress: string | null } | null;
  zkLoginAvailable: boolean;
}

interface Me {
  account: (OnboardingAccount & { ownerKind: OwnerKind }) | null;
}

/** Which owner wallet this account will use. */
type Choice =
  | { kind: "zklogin"; address: string }
  | { kind: "wallet"; address: string; wallet: Wallet; account: WalletAccount }
  | { kind: "browser"; address: string };

function parseRecipients(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export default function Onboarding() {
  const client = useRef(createSuiClient());
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [existing, setExisting] = useState<Me["account"]>(null);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [choice, setChoice] = useState<Choice | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [pickAccounts, setPickAccounts] = useState<{ wallet: Wallet; accounts: readonly WalletAccount[] } | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [reusableVault, setReusableVault] = useState<string | null>(null);
  const [packageId, setPackageId] = useState<string | null>(null);
  const [account, setAccount] = useState<OnboardingAccount | null>(null);
  const [deposit, setDeposit] = useState(formatSui(DEFAULT_ONBOARDING_POLICY.depositMist));
  const [agentGas, setAgentGas] = useState(formatSui(DEFAULT_ONBOARDING_POLICY.agentGasMist));
  const [dayCap, setDayCap] = useState(formatSui(DEFAULT_ONBOARDING_POLICY.dayCapMist));
  const [weekCap, setWeekCap] = useState(formatSui(DEFAULT_ONBOARDING_POLICY.weekCapMist));
  const [recipients, setRecipients] = useState("");
  const [step, setStep] = useState<OnboardingStep | null>(null);
  const [failedStep, setFailedStep] = useState<{ step: OnboardingStep; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Who is signed in, and whether they already started an account.
  useEffect(() => {
    void (async () => {
      try {
        const [sessionBody, meBody] = await Promise.all([
          fetch("/api/auth/session", { cache: "no-store" }).then((r) => r.json() as Promise<SessionInfo>),
          fetch("/api/accounts/me", { cache: "no-store" }).then((r) => r.json() as Promise<Me>),
        ]);
        setSession(sessionBody);
        setExisting(meBody.account);
      } catch {
        setSession({ user: null, zkLoginAvailable: false });
      }
    })();
    const params = new URLSearchParams(window.location.search);
    if (params.get("auth") === "failed") setNotice("Google sign-in did not complete. Try again.");
    if (params.get("zk") === "failed") {
      setNotice(
        "Signed in, but your Google wallet could not be opened. Check ENOKI_API_KEY and that this Google client ID is added to your Enoki app, then sign in again.",
      );
    }
  }, []);

  // Installed wallet extensions announce themselves asynchronously.
  useEffect(() => {
    setWallets(listSuiWallets());
    return onWalletsChanged(() => setWallets(listSuiWallets()));
  }, []);

  // Default choice: an account already started picks its own owner; otherwise the sign-in wallet.
  useEffect(() => {
    if (!session?.user || choice) return;
    if (existing) {
      if (existing.status === "active") {
        setAccount(existing);
        return;
      }
      if (existing.ownerKind === "zklogin") setChoice({ kind: "zklogin", address: existing.ownerAddress });
      else if (existing.ownerKind === "browser" && loadWallet("owner")?.address === existing.ownerAddress) {
        setChoice({ kind: "browser", address: existing.ownerAddress });
      } else setMode("existing");
      return;
    }
    if (session.user.zkAddress) setChoice({ kind: "zklogin", address: session.user.zkAddress });
  }, [session, existing, choice]);

  const refresh = useCallback(async () => {
    if (!choice) return;
    try {
      setBalance(await getSuiBalance(client.current, choice.address));
      const response = await fetch(`/api/accounts?owner=${encodeURIComponent(choice.address)}`, { cache: "no-store" });
      const body = (await response.json()) as { account: OnboardingAccount | null; packageId?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load your account.");
      if (body.account) setAccount(body.account);
      if (body.packageId) {
        setPackageId(body.packageId);
        const found = await findExistingVault(choice.address, body.packageId);
        setReusableVault(found?.vaultId ?? null);
      }
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [choice]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function readPolicy(): OnboardingPolicy {
    return {
      ...DEFAULT_ONBOARDING_POLICY,
      depositMist: parseToMist(deposit),
      agentGasMist: parseToMist(agentGas),
      dayCapMist: parseToMist(dayCap),
      weekCapMist: parseToMist(weekCap),
      allowedRecipients: parseRecipients(recipients),
    };
  }

  async function pickWallet(wallet: Wallet) {
    setNotice(null);
    try {
      const accounts = await connectWallet(wallet);
      if (accounts.length === 0) throw new Error(`${wallet.name} did not share any accounts.`);
      if (accounts.length === 1) selectWalletAccount(wallet, accounts[0]);
      else setPickAccounts({ wallet, accounts });
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  function selectWalletAccount(wallet: Wallet, walletAccount: WalletAccount) {
    setPickAccounts(null);
    setBalance(null);
    setReusableVault(null);
    setChoice({ kind: "wallet", address: walletAccount.address, wallet, account: walletAccount });
  }

  /** The signed link message, for owners whose address the server cannot derive itself. */
  async function linkProof(current: Choice): Promise<{ token: string; signature: string } | undefined> {
    if (current.kind === "zklogin" || account) return undefined;
    const response = await fetch("/api/accounts/link-challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: current.address }),
    });
    const challenge = (await response.json()) as { message?: string; token?: string; error?: string };
    if (!response.ok || !challenge.message || !challenge.token) throw new Error(challenge.error ?? "Could not start linking.");
    const signature =
      current.kind === "wallet"
        ? await signMessageWithWallet(current.wallet, current.account, challenge.message)
        : await signMessageWithBrowserKey(loadWallet("owner")!.keypair, challenge.message);
    return { token: challenge.token, signature };
  }

  async function create() {
    if (!choice || !session?.user) return;
    setBusy(true);
    setNotice(null);
    setFailedStep(null);
    let current: OnboardingStep = "check";
    try {
      const signer: Signer =
        choice.kind === "wallet"
          ? signerForWalletAccount(choice.wallet, choice.account)
          : await ownerSigner({ ownerKind: choice.kind, ownerAddress: choice.address });
      const proof = await linkProof(choice);
      const done = await createAccount({
        owner: signer,
        ownerKind: choice.kind,
        proof,
        policy: readPolicy(),
        onStep: (next) => {
          current = next;
          setStep(next);
        },
      });
      setAccount(done);
      setStep(null);
      window.setTimeout(() => window.location.assign("/chat"), 2_000);
    } catch (error) {
      setFailedStep({ step: current, message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function openFaucet() {
    if (!choice) return;
    await navigator.clipboard.writeText(choice.address).catch(() => undefined);
    window.open(FAUCET_PAGE_URL, "_blank", "noopener");
    setNotice("Address copied. Request testnet SUI on the faucet; the balance updates by itself.");
  }

  let required: bigint | null = null;
  try {
    const policy = readPolicy();
    required = reusableVault ? policy.agentGasMist + 20_000_000n : requiredOwnerBalanceMist(policy);
  } catch {
    required = null;
  }
  const funded = balance !== null && required !== null && balance >= required;
  const active = account?.status === "active" && account.vault;
  const user = session?.user;

  // While waiting on the faucet, keep checking so Create enables the moment SUI lands.
  useEffect(() => {
    if (!choice || active || funded) return;
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [choice, active, funded, refresh]);

  const lockedToExisting = Boolean(existing && existing.status !== "active");

  return (
    <main className="page">
      <header className="masthead">
        <div>
          <p className="eyebrow">
            <span className="pill">{NETWORK}</span> Coins here have no value
          </p>
          <h1>{active ? "You're all set" : "Set up your account"}</h1>
          <p className="lede">
            Your wallet is tied to your Google account, so it follows you to any device. Your wallet owns a vault and
            sets its limits. Cipher gets a separate key that can only spend inside those limits.
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

      {session && !user && (
        <div className="notice" role="status">
          <span>Sign in with Google to set up your account.</span>
          <button onClick={() => void startGoogleSignIn()}>Sign in with Google</button>
        </div>
      )}
      {user && <p className="muted small">Signed in as {user.email}.</p>}

      {user && !active && (
        <section className="steps">
          <article className="card">
            <div className="card-head">
              <span className="step">1</span>
              <h2>Your wallet</h2>
            </div>
            {!lockedToExisting && (
              <div className="actions" role="tablist">
                <button
                  className={mode === "new" ? undefined : "secondary"}
                  onClick={() => {
                    setMode("new");
                    setChoice(user.zkAddress ? { kind: "zklogin", address: user.zkAddress } : null);
                  }}
                >
                  Create a new wallet
                </button>
                <button
                  className={mode === "existing" ? undefined : "secondary"}
                  onClick={() => {
                    setMode("existing");
                    setChoice(null);
                  }}
                >
                  Use an existing wallet
                </button>
              </div>
            )}

            {mode === "new" && choice?.kind !== "browser" && (
              <>
                <p className="muted">
                  A wallet created from your Google sign-in (zkLogin). There is no seed phrase to lose: sign in with
                  Google on any device and it is yours.
                </p>
                {!user.zkAddress && (
                  <p className="muted">
                    {session?.zkLoginAvailable
                      ? "Your wallet session expired. Sign in again to open it."
                      : "zkLogin is not configured on this server (set ENOKI_API_KEY)."}{" "}
                    {session?.zkLoginAvailable && (
                      <button className="link" onClick={() => void startGoogleSignIn()}>
                        Sign in again
                      </button>
                    )}
                  </p>
                )}
              </>
            )}

            {mode === "existing" && (
              <>
                <p className="muted">
                  Bring a wallet you already use, like Slush. You keep the same address and funds. Your wallet only pops
                  up for owner actions like changing limits; everyday spending happens here through Cipher.
                </p>
                {wallets.length === 0 && (
                  <p className="muted small">
                    No Sui wallet found in this browser. Install{" "}
                    <a href="https://slush.app" target="_blank" rel="noreferrer">
                      Slush
                    </a>{" "}
                    (or another Sui wallet), then reload this page.
                  </p>
                )}
                {!pickAccounts && (
                  <div className="actions">
                    {wallets.map((wallet) => (
                      <button key={wallet.name} className="secondary" onClick={() => void pickWallet(wallet)}>
                        {wallet.icon && <img src={wallet.icon} alt="" width={16} height={16} />} Connect {wallet.name}
                      </button>
                    ))}
                  </div>
                )}
                {pickAccounts && (
                  <div className="field">
                    <span>Which {pickAccounts.wallet.name} account?</span>
                    <div className="actions">
                      {pickAccounts.accounts.map((walletAccount) => (
                        <button
                          key={walletAccount.address}
                          className="secondary"
                          onClick={() => selectWalletAccount(pickAccounts.wallet, walletAccount)}
                        >
                          {walletAccount.label ? `${walletAccount.label} · ` : ""}
                          <span className="mono">{shortAddress(walletAccount.address)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {choice && (
              <>
                <div className="wallet">
                  <div>
                    <p className="wallet-label">
                      {choice.kind === "zklogin" ? "Your Google wallet" : choice.kind === "wallet" ? choice.wallet.name : "This browser's wallet"}
                    </p>
                    <a className="mono" href={explorerAddressUrl(choice.address)} target="_blank" rel="noreferrer" title={choice.address}>
                      {shortAddress(choice.address)}
                    </a>
                  </div>
                  <div className="wallet-side">
                    <span className="balance">{balance === null ? "—" : `${formatSui(balance)} SUI`}</span>
                  </div>
                </div>
                <div className="actions">
                  <button className="secondary" onClick={openFaucet}>
                    Copy address and open faucet
                  </button>
                  <button className="ghost" onClick={() => void refresh()}>
                    Refresh
                  </button>
                </div>
              </>
            )}
          </article>

          {choice && (
            <article className="card">
              <div className="card-head">
                <span className="step">2</span>
                <h2>{reusableVault ? "Connect your vault" : "Vault and limits"}</h2>
              </div>
              {reusableVault ? (
                <p className="muted">
                  This wallet already owns a vault (<span className="mono">{shortAddress(reusableVault)}</span>). We will
                  reuse it: its balance, limits and trusted recipients stay exactly as they are. Cipher just gets
                  permission to work inside it. Change limits later in Settings.
                </p>
              ) : (
                <>
                  <p className="muted">
                    The vault holds the money Cipher may spend. Cipher cannot exceed these limits, and only your wallet
                    can change them.
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
                    Cipher can only pay trusted recipients directly. With none listed, every payment needs your approval.
                  </p>
                </>
              )}
              <label className="field narrow">
                <span>Gas for Cipher (SUI)</span>
                <input value={agentGas} onChange={(e) => setAgentGas(e.target.value)} inputMode="decimal" />
              </label>
              {required !== null && <p className="muted small">Needs about {formatSui(required)} SUI in your wallet.</p>}
              <div className="actions">
                <button onClick={() => void create()} disabled={busy || !funded || !packageId}>
                  {busy ? "Working…" : reusableVault ? "Connect my vault" : "Create my vault"}
                </button>
                {!funded && balance !== null && <span className="muted small">Fund your wallet first.</span>}
              </div>
              {(step || failedStep) && (
                <ol className="calls">
                  {STEPS.map((entry, index) => {
                    const at = failedStep?.step ?? step;
                    const current = STEPS.findIndex((candidate) => candidate.id === at);
                    const failed = failedStep && index === current;
                    const state = index < current ? "done" : index === current ? "now" : "todo";
                    return (
                      <li key={entry.id} className={state === "todo" ? "muted" : undefined}>
                        {failed ? "✗ " : state === "done" ? "✓ " : state === "now" ? "… " : "  "}
                        {entry.label}
                        {failed && (
                          <p className="error-text" role="alert">
                            {failedStep.message}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </article>
          )}
        </section>
      )}

      {active && account.vault && (
        <section className="steps">
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
                <strong>Your wallet</strong> <span className="mono">{shortAddress(account.ownerAddress)}</span>
              </p>
              <p>
                <strong>Cipher&apos;s key</strong> <span className="mono">{shortAddress(account.agentAddress)}</span>
              </p>
            </div>
            <div className="actions">
              <button onClick={() => window.location.assign("/chat")}>Chat with Cipher</button>
            </div>
          </article>
        </section>
      )}
    </main>
  );
}
