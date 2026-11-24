"use client";

import { useCallback, useEffect, useState } from "react";
import { AccountBar } from "@/components/AccountBar";
import { ContactsCard } from "@/components/ContactsCard";
import { VaultMoneyCard } from "@/components/VaultMoneyCard";
import { createSuiClient, explorerAddressUrl, FAUCET_PAGE_URL, formatSui, getSuiBalance, NETWORK } from "@/lib/sui";
import { execute } from "@/lib/onboarding";
import { ownerSigner, OwnerSignerError, startGoogleSignIn, type OwnerKind } from "@/lib/owner-signer";
import { buildPolicyUpdateTx, normalizeRecipients, readVaultPolicy, type PolicyReader, type VaultPolicy } from "@/lib/owner-tx";
import { changesFor, formFrom, type PermissionForm } from "@/lib/permission-form";

interface AccountView {
  id: string;
  status: "pending" | "active";
  ownerAddress: string;
  ownerKind: OwnerKind;
  agentAddress: string;
  vault: { packageId: string; vaultId: string; ownerCapId: string; agentCapId: string } | null;
  displayName: string | null;
}

interface Me {
  user: { email: string; name: string | null } | null;
  account: AccountView | null;
}

const shortAddress = (address: string) => `${address.slice(0, 10)}…${address.slice(-6)}`;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function SettingsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [policy, setPolicy] = useState<VaultPolicy | null>(null);
  const [form, setForm] = useState<PermissionForm | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"name" | "permissions" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/accounts/me", { cache: "no-store" })
      .then((response) => response.json() as Promise<Me>)
      .then((body) => {
        if (!body.user) return window.location.replace("/");
        if (!body.account || body.account.status !== "active" || !body.account.vault) {
          return window.location.replace("/onboarding");
        }
        setMe(body);
        setName(body.account.displayName ?? body.user.name ?? "");
      })
      .catch(() => setError("Could not load your account. Refresh the page."));
  }, []);

  const [signerProblem, setSignerProblem] = useState<OwnerSignerError | null>(null);

  const refresh = useCallback(async () => {
    const vault = me?.account?.vault;
    if (!vault) return;
    const client = createSuiClient();
    const next = await readVaultPolicy(client as unknown as PolicyReader, vault.vaultId);
    setPolicy(next);
    setForm(formFrom(next));
    setBalance(await getSuiBalance(client, me.account!.ownerAddress));
  }, [me]);

  useEffect(() => {
    refresh().catch((reason) => setError(errorMessage(reason)));
  }, [refresh]);

  async function saveName() {
    setBusy("name");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/accounts/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: name }),
      });
      const body = (await response.json()) as { account?: AccountView; error?: string };
      if (!response.ok || !body.account) throw new Error(body.error ?? "Could not save your name.");
      setMe((previous) => (previous ? { ...previous, account: body.account! } : previous));
      setNotice("Profile saved.");
      window.dispatchEvent(new CustomEvent("cipher:profile-renamed", { detail: body.account.displayName }));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  async function savePermissions() {
    if (!me?.account?.vault || !policy || !form) return;
    setBusy("permissions");
    setError(null);
    setNotice(null);
    try {
      const { packageId, vaultId, ownerCapId } = me.account.vault;
      const changes = changesFor(form, policy);
      const tx = buildPolicyUpdateTx({ packageId, vaultId, ownerCapId, changes });
      const signer = await ownerSigner(me.account);
      setSignerProblem(null);
      await execute(createSuiClient(), signer, tx);
      await refresh();
      setNotice("Permissions updated on-chain. Your agent follows the new rules from now on.");
    } catch (reason) {
      if (reason instanceof OwnerSignerError) setSignerProblem(reason);
      else setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  function addRecipient() {
    if (!form) return;
    try {
      const [address] = normalizeRecipients([form.newRecipient]);
      if (!address) return;
      if (form.recipients.includes(address)) throw new Error("That address is already trusted.");
      setForm({ ...form, recipients: [...form.recipients, address], newRecipient: "" });
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  const disabled = busy !== null || !form;
  const ownerLabel =
    me?.account?.ownerKind === "zklogin"
      ? "Your Google wallet (zkLogin)"
      : me?.account?.ownerKind === "wallet"
        ? "Your connected wallet"
        : "This browser's wallet";

  return (
    <main className="page wide">
      <header className="masthead">
        <AccountBar links={[{ href: "/chat", label: "← Back to chat" }, { href: "/dashboard", label: "Dashboard" }]} />
        <p className="eyebrow">
          <span className="pill">{NETWORK}</span> Coins here have no value
        </p>
        <h1>Account settings</h1>
        <p className="lede">
          Your owner wallet controls the vault. Change your name or the limits your agent works under. Only your owner
          wallet can sign permission changes.
        </p>
      </header>

      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button className="link" onClick={() => setNotice(null)} aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      )}
      {error && (
        <div className="notice" role="alert">
          <span>{error}</span>
          <button className="link" onClick={() => setError(null)} aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      )}

      <section className="steps">
        <article className="card">
          <div className="card-head">
            <h2>Profile</h2>
          </div>
          <label className="field">
            <span>Display name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} />
          </label>
          <div className="actions">
            <button onClick={() => void saveName()} disabled={!me || busy !== null || !name.trim()}>
              {busy === "name" ? "Saving…" : "Save name"}
            </button>
          </div>
          {me?.user && <p className="muted small">Signed in as {me.user.email}.</p>}
        </article>

        <article className="card">
          <div className="card-head">
            <h2>Owner wallet</h2>
          </div>
          {me?.account && (
            <div className="wallet">
              <div>
                <p className="wallet-label">{ownerLabel}</p>
                <a
                  className="mono"
                  href={explorerAddressUrl(me.account.ownerAddress)}
                  target="_blank"
                  rel="noreferrer"
                  title={me.account.ownerAddress}
                >
                  {shortAddress(me.account.ownerAddress)}
                </a>
              </div>
              <div className="wallet-side">
                <span className="balance">{balance === null ? "—" : `${formatSui(balance)} SUI`}</span>
              </div>
            </div>
          )}
          {me?.account?.ownerKind === "wallet" && (
            <p className="muted small">Saving permissions opens your wallet to approve the change.</p>
          )}
          {signerProblem && (
            <p className="muted" role="alert">
              {signerProblem.message}{" "}
              {signerProblem.code === "zk_expired" && (
                <button className="link" onClick={() => void startGoogleSignIn()}>
                  Sign in again
                </button>
              )}
            </p>
          )}
          {balance !== null && balance === 0n && (
            <p className="muted">
              Your owner wallet needs SUI for transaction fees. <a href={FAUCET_PAGE_URL} target="_blank" rel="noreferrer">Open the faucet</a>.
            </p>
          )}
        </article>

        {me?.account?.vault && <VaultMoneyCard onChanged={() => void refresh().catch(() => undefined)} />}

        {me?.account?.vault && (
          <ContactsCard trusted={policy?.allowedRecipients ?? []} onChanged={() => void refresh().catch(() => undefined)} />
        )}

        {form && policy && (
          <article className="card">
            <div className="card-head">
              <h2>Permissions</h2>
            </div>
            <p className="muted">
              Each change is one transaction signed by your owner wallet. Leave a cap empty if it is not set. Zero blocks
              spending in that window.
            </p>
            <label className="field narrow">
              <span>Per-transaction limit (SUI)</span>
              <input
                value={form.perTx}
                onChange={(event) => setForm({ ...form, perTx: event.target.value })}
                inputMode="decimal"
                disabled={disabled}
              />
            </label>
            <label className="field narrow">
              <span>Per-epoch spend cap (SUI)</span>
              <input
                value={form.spendCap}
                onChange={(event) => setForm({ ...form, spendCap: event.target.value })}
                inputMode="decimal"
                placeholder="Not set"
                disabled={disabled}
              />
            </label>
            <label className="field narrow">
              <span>Daily cap (SUI)</span>
              <input
                value={form.dayCap}
                onChange={(event) => setForm({ ...form, dayCap: event.target.value })}
                inputMode="decimal"
                placeholder="Not set"
                disabled={disabled}
              />
            </label>
            <label className="field narrow">
              <span>Weekly cap (SUI)</span>
              <input
                value={form.weekCap}
                onChange={(event) => setForm({ ...form, weekCap: event.target.value })}
                inputMode="decimal"
                placeholder="Not set"
                disabled={disabled}
              />
            </label>
            <label className="field">
              <span>
                <input
                  type="checkbox"
                  checked={form.enforce}
                  onChange={(event) => setForm({ ...form, enforce: event.target.checked })}
                  disabled={disabled}
                />{" "}
                Only pay trusted recipients directly
              </span>
            </label>

            <div className="field">
              <span>Trusted recipients</span>
              {form.recipients.length === 0 && <p className="muted small">None yet.</p>}
              <ul className="muted small">
                {form.recipients.map((address) => (
                  <li key={address}>
                    <span className="mono" title={address}>
                      {shortAddress(address)}
                    </span>{" "}
                    <button
                      className="link"
                      disabled={disabled}
                      onClick={() => setForm({ ...form, recipients: form.recipients.filter((item) => item !== address) })}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <div className="actions">
                <input
                  value={form.newRecipient}
                  onChange={(event) => setForm({ ...form, newRecipient: event.target.value })}
                  placeholder="0x…"
                  spellCheck={false}
                  disabled={disabled}
                />
                <button className="secondary" onClick={addRecipient} disabled={disabled || !form.newRecipient.trim()}>
                  Add recipient
                </button>
              </div>
            </div>

            <div className="actions">
              <button onClick={() => void savePermissions()} disabled={disabled}>
                {busy === "permissions" ? "Signing…" : "Save permissions"}
              </button>
              <button className="ghost" onClick={() => setForm(formFrom(policy))} disabled={disabled}>
                Discard changes
              </button>
            </div>
          </article>
        )}
      </section>
    </main>
  );
}
