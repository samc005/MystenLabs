"use client";

import { useEffect, useMemo, useState } from "react";
import {
  buildAgentPermissionsTx,
  formatDecimal,
  permissionChanges,
  permissionsApproval,
  permissionsFormFrom,
  type AgentPermissionsForm,
} from "@/lib/agent-permissions";
import { execute } from "@/lib/onboarding";
import type { VaultPolicy } from "@/lib/owner-tx";
import { ownerSigner, OwnerSignerError, startGoogleSignIn, type OwnerKind } from "@/lib/owner-signer";
import { approveProposalWithEnrollment, hashProposal } from "@/lib/passkey";
import { createSuiClient, explorerTxUrl } from "@/lib/sui";
import { shortAddress } from "@/lib/display";

interface Validator {
  name: string;
  address: string;
  commissionPercent: number;
}

interface Props {
  account: { ownerKind: OwnerKind; ownerAddress: string; vault: { packageId: string; vaultId: string; ownerCapId: string } };
  policy: VaultPolicy;
  onSaved: () => void;
}

/** Turn staking and swaps on or off for Cipher, with the limits the contract requires. */
export function AgentPermissionsCard({ account, policy, onSaved }: Props) {
  const [form, setForm] = useState<AgentPermissionsForm>(() => permissionsFormFrom(policy));
  const [validators, setValidators] = useState<Validator[]>([]);
  const [busy, setBusy] = useState<"passkey" | "wallet" | null>(null);
  const [error, setError] = useState<{ message: string; signIn: boolean } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => setForm(permissionsFormFrom(policy)), [policy]);
  useEffect(() => {
    void fetch("/api/validators", { cache: "no-store" })
      .then((response) => response.json() as Promise<{ validators?: Validator[] }>)
      .then((body) => setValidators(body.validators ?? []))
      .catch(() => setValidators([]));
  }, []);

  const nameOf = useMemo(() => new Map(validators.map((v) => [v.address, v.name])), [validators]);
  const choices = validators.filter((v) => !form.validators.includes(v.address)).slice(0, 25);
  const set = (patch: Partial<AgentPermissionsForm>) => setForm((current) => ({ ...current, ...patch }));
  const disabled = busy !== null;
  const ruleExpired = policy.swapRule ? policy.swapRule.expiryMs < Date.now() : false;

  async function save() {
    setError(null);
    setSaved(null);
    try {
      const changes = permissionChanges(form, policy);
      const tx = buildAgentPermissionsTx(changes, account.vault);
      setBusy("passkey");
      await approveProposalWithEnrollment(await hashProposal(permissionsApproval(account.vault.vaultId)));
      setBusy("wallet");
      const digest = await execute(createSuiClient(), await ownerSigner(account), tx);
      setSaved(digest);
      onSaved();
    } catch (reason) {
      setError({
        message: reason instanceof Error ? reason.message : String(reason),
        signIn: reason instanceof OwnerSignerError && reason.code === "zk_expired",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="card">
      <div className="card-head">
        <h2>What Cipher can do</h2>
      </div>
      <p className="muted">
        Payments are always on. Staking and swaps are off until you turn them on here, each with its own limits. The vault
        contract enforces them; one passkey approval and one wallet signature save everything.
      </p>

      <p className="muted small holdings-line">
        Staked now: <strong>{formatDecimal(policy.stake?.stakedMist ?? 0n, 9)} SUI</strong>
        {policy.stake ? ` in ${policy.stake.positions.toString()} stake${policy.stake.positions === 1n ? "" : "s"}` : ""} · Set aside for swaps:{" "}
        <strong>{formatDecimal(policy.tradingSuiMist ?? 0n, 9)} SUI</strong> · In your vault: <strong>{formatDecimal(policy.balanceMist ?? 0n, 9)} SUI</strong>
      </p>

      <label className="toggle">
        <input type="checkbox" checked={form.staking} onChange={(e) => set({ staking: e.target.checked })} disabled={disabled} />
        <span>Let Cipher stake SUI from the vault</span>
      </label>
      {form.staking && (
        <div className="permission-group">
          <label className="field narrow">
            <span>Most staked in total (SUI)</span>
            <input value={form.maxStaked} onChange={(e) => set({ maxStaked: e.target.value })} inputMode="decimal" disabled={disabled} />
          </label>
          <label className="field narrow">
            <span>Always keep unstaked (SUI)</span>
            <input value={form.minReserve} onChange={(e) => set({ minReserve: e.target.value })} inputMode="decimal" disabled={disabled} />
          </label>
          <label className="field narrow">
            <span>Most separate stakes</span>
            <input value={form.maxPositions} onChange={(e) => set({ maxPositions: e.target.value })} inputMode="numeric" disabled={disabled} />
          </label>
          <div className="field">
            <span>Validators Cipher may stake with</span>
            {form.validators.length === 0 && <p className="muted small">None yet. Pick at least one.</p>}
            <ul className="muted small">
              {form.validators.map((address) => (
                <li key={address}>
                  {nameOf.get(address) ?? <span className="mono">{shortAddress(address)}</span>}{" "}
                  <button className="link" onClick={() => set({ validators: form.validators.filter((v) => v !== address) })} disabled={disabled}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <select
              value=""
              onChange={(e) => e.target.value && set({ validators: [...form.validators, e.target.value] })}
              disabled={disabled || choices.length === 0}
            >
              <option value="">{validators.length ? "Add a validator…" : "Loading validators…"}</option>
              {choices.map((v) => (
                <option key={v.address} value={v.address}>
                  {v.name} ({v.commissionPercent}% fee)
                </option>
              ))}
            </select>
          </div>
          <p className="muted small">Sui&apos;s minimum stake is 1 SUI.</p>
        </div>
      )}

      <label className="toggle">
        <input type="checkbox" checked={form.trading} onChange={(e) => set({ trading: e.target.checked })} disabled={disabled} />
        <span>Let Cipher swap SUI for tUSDC</span>
      </label>
      {form.trading && (
        <div className="permission-group">
          <label className="field narrow">
            <span>Most per swap (SUI)</span>
            <input value={form.maxPerSwap} onChange={(e) => set({ maxPerSwap: e.target.value })} inputMode="decimal" disabled={disabled} />
          </label>
          <label className="field narrow">
            <span>Most per day (SUI)</span>
            <input value={form.maxPerDay} onChange={(e) => set({ maxPerDay: e.target.value })} inputMode="decimal" disabled={disabled} />
          </label>
          <label className="field narrow">
            <span>Worst price (tUSDC per SUI)</span>
            <input value={form.minUsdcPerSui} onChange={(e) => set({ minUsdcPerSui: e.target.value })} inputMode="decimal" disabled={disabled} />
          </label>
          <label className="field narrow">
            <span>Rule lasts (days)</span>
            <input value={form.ruleDays} onChange={(e) => set({ ruleDays: e.target.value })} inputMode="numeric" disabled={disabled} />
          </label>
          <label className="field narrow">
            <span>Move into trading balance now (SUI)</span>
            <input value={form.addToTrading} onChange={(e) => set({ addToTrading: e.target.value })} inputMode="decimal" disabled={disabled} />
          </label>
          <p className="muted small">
            Swaps only use the trading balance, which now holds {formatDecimal(policy.tradingSuiMist ?? 0n, 9)} SUI. It comes out of your vault.
            {ruleExpired && " Your current swap rule has expired; saving renews it."} The testnet market trades at about 2 tUSDC per SUI.
          </p>
        </div>
      )}

      {error && (
        <p className="error-text" role="alert">
          {error.message}{" "}
          {error.signIn && (
            <button className="link" onClick={() => void startGoogleSignIn()}>
              Sign in again
            </button>
          )}
        </p>
      )}
      {saved && (
        <p className="small">
          Saved on-chain.{" "}
          <a className="receipt-link" href={explorerTxUrl(saved)} target="_blank" rel="noreferrer">
            View receipt ↗
          </a>
        </p>
      )}
      <div className="actions">
        <button onClick={() => void save()} disabled={disabled}>
          {busy === "passkey" ? "Confirm with your passkey…" : busy === "wallet" ? "Waiting for your wallet…" : "Approve with passkey and save"}
        </button>
      </div>
    </article>
  );
}
