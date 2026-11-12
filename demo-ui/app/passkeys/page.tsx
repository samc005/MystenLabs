"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getPasskeyStatus, registerPasskey, listPasskeys, removePasskey, recoverPasskeys,
  approveProposal, hashProposal, setPasskeyRevoked, type PasskeyStatus, type RegisteredPasskey } from "@/lib/passkey";

export default function PasskeysPage() {
  const [status, setStatus] = useState<PasskeyStatus | null>(null);
  const [credentials, setCredentials] = useState<RegisteredPasskey[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [code, setCode] = useState("");
  const [recoveryToken, setRecoveryToken] = useState<string>();
  async function refresh() { setStatus(await getPasskeyStatus()); }
  useEffect(() => { void refresh().catch(error => setMessage(String(error))); }, []);
  async function run(work: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await work(); await refresh(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <main className="page">
    <Link href="/chat">← Wallet chat</Link>
    <h1>Manage passkeys</h1>
    <section className="card">
      <p>{status ? status.credentialCount + " registered device(s) · " + (status.revoked ? "wallet locked" : "wallet active") : "Loading…"}</p>
      <p>Add a replacement before removing your last working passkey. Removing a device here removes its access to this application; it does not delete the passkey from your password manager.</p>
      <div className="actions">
        <button disabled={busy || !status || Boolean(status.recoveryPending && !recoveryToken)}
          onClick={() => run(async () => { await registerPasskey(recoveryToken); setRecoveryToken(undefined); setCredentials([]); setMessage("New passkey registered. You can now unlock the wallet if needed."); })}>Add new passkey</button>
        <button disabled={busy || !status?.registered}
          onClick={() => run(async () => { setCredentials(await listPasskeys()); })}>Show registered devices</button>
        {status?.registered && status.revoked && <button disabled={busy}
          onClick={() => run(async () => {
            const hash = await hashProposal({ action: "restore-ai-access", network: "testnet", reason: "Owner unlock" });
            const { approvalId } = await approveProposal(hash);
            await setPasskeyRevoked(approvalId, hash, false);
            setMessage("Wallet unlocked. Return to chat.");
          })}>Unlock with new passkey</button>}
      </div>
      {credentials.map(credential => <div className="card" key={credential.id}>
        <strong>{credential.label}</strong><p>Added {new Date(credential.createdAt).toLocaleString()}</p>
        <button disabled={busy || (status?.credentialCount ?? 0) <= 1}
          onClick={() => run(async () => {
            await removePasskey(credential.id);
            setCredentials(previous => previous.filter(item => item.id !== credential.id));
            setMessage("Old credential removed. Pending approvals were invalidated.");
          })}>Remove this credential</button>
      </div>)}
    </section>
    <section className="card">
      <h2>Lost every passkey?</h2>
      <p>If you deleted the passkey from Google Password Manager, the application cannot use its old registration. Generate a one-time recovery code in a private local terminal, from the repository root:</p>
      <pre>npm run passkeys:recover --prefix demo-ui</pre>
      <p>The code expires in 10 minutes. Recovery backs up old registrations, invalidates pending approvals, and locks wallet actions. Stay on this page, add a new passkey, then unlock with it. Recovery does not change your wallet keys or on-chain funds.</p>
      <label className="field"><span>One-time local recovery code</span>
        <input type="password" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} />
      </label>
      <button disabled={busy || !code.trim()} onClick={() => run(async () => {
        const token = await recoverPasskeys(code.trim());
        setRecoveryToken(token); setCode(""); setCredentials([]);
        setMessage("Recovery authorized. Click Add new passkey above, then Unlock with new passkey. Keep this tab open.");
      })}>Recover and replace registrations</button>
      {status?.recoveryPending && !recoveryToken && <p>Recovery is pending. Return to the recovery tab, or generate a new code to restart.</p>}
    </section>
    {message && <p role="status" className="notice">{message}</p>}
  </main>;
}
