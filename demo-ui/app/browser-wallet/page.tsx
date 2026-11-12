"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseToMist } from "@mysten/sui/utils";
import {
  createSuiClient,
  explorerAddressUrl,
  FAUCET_PAGE_URL,
  formatBalanceReport,
  formatSui,
  formatTransferReceipt,
  getAllBalances,
  getSuiBalance,
  NETWORK,
  transferSui,
  type TransferReceipt,
} from "@/lib/sui";
import { loadOrCreateWallet, resetWallet, type DemoWallet } from "@/lib/wallet";
import {
  approveProposal,
  getPasskeyStatus,
  hashProposal,
  registerPasskey,
  setPasskeyRevoked,
  type PasskeyStatus,
} from "@/lib/passkey";

const DEFAULT_AMOUNT = "0.01";
const PASSKEY_THRESHOLD_MIST = 100_000_000n;
const FUNDING_POLL_MS = 4_000;
const FUNDING_TIMEOUT_MS = 10 * 60_000;

interface ToolCall {
  id: number;
  tool: "get_balance" | "transfer_sui" | "passkey_approval";
  args: Record<string, string>;
  output: string;
  isError: boolean;
  at: string;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function Home() {
  const client = useRef(createSuiClient());
  const nextId = useRef(1);

  const [sender, setSender] = useState<DemoWallet | null>(null);
  const [receiver, setReceiver] = useState<DemoWallet | null>(null);
  const [senderBalance, setSenderBalance] = useState<bigint | null>(null);
  const [receiverBalance, setReceiverBalance] = useState<bigint | null>(null);
  const [watching, setWatching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  const [receipt, setReceipt] = useState<TransferReceipt | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [calls, setCalls] = useState<ToolCall[]>([]);
  const [passkey, setPasskey] = useState<PasskeyStatus | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  const logCall = useCallback((call: Omit<ToolCall, "id" | "at">) => {
    const entry = { ...call, id: nextId.current++, at: new Date().toLocaleTimeString() };
    setCalls((previous) => [entry, ...previous]);
  }, []);

  // Wallets live in localStorage, so they load after mount, never during server render.
  useEffect(() => {
    const s = loadOrCreateWallet("sender");
    const r = loadOrCreateWallet("receiver");
    setSender(s);
    setReceiver(r);
    setRecipient(r.address);
    void getPasskeyStatus().then(setPasskey).catch((error) => setNotice(errorMessage(error)));
  }, []);

  const refreshBalances = useCallback(
    async (log: boolean) => {
      if (!sender || !receiver) return;
      setRefreshing(true);
      try {
        const [senderAll, receiverSui] = await Promise.all([
          getAllBalances(client.current, sender.address),
          getSuiBalance(client.current, receiver.address),
        ]);
        const sui = senderAll.find((b) => b.symbol === "SUI")?.raw ?? 0n;
        setSenderBalance(sui);
        setReceiverBalance(receiverSui);
        if (log) {
          logCall({ tool: "get_balance", args: {}, output: formatBalanceReport(sender.address, senderAll), isError: false });
        }
        return sui;
      } catch (error) {
        if (log) logCall({ tool: "get_balance", args: {}, output: errorMessage(error), isError: true });
        setNotice(`Could not read balances: ${errorMessage(error)}`);
      } finally {
        setRefreshing(false);
      }
    },
    [sender, receiver, logCall],
  );

  useEffect(() => {
    if (sender && receiver) void refreshBalances(true);
  }, [sender, receiver, refreshBalances]);

  // While waiting on the faucet, poll until the sender balance goes up.
  useEffect(() => {
    if (!watching || !sender) return;
    const baseline = senderBalance ?? 0n;
    const startedAt = Date.now();
    const timer = window.setInterval(async () => {
      if (Date.now() - startedAt > FUNDING_TIMEOUT_MS) {
        setWatching(false);
        setNotice("Stopped waiting for faucet SUI. Press Refresh once the faucet says it sent the coins.");
        return;
      }
      try {
        const current = await getSuiBalance(client.current, sender.address);
        if (current > baseline) {
          setWatching(false);
          setNotice(`Received ${formatSui(current - baseline)} SUI from the faucet.`);
          await refreshBalances(true);
        }
      } catch {
        // Keep polling. A single failed read is not worth surfacing.
      }
    }, FUNDING_POLL_MS);
    return () => window.clearInterval(timer);
    // senderBalance is deliberately read once, as the baseline when watching starts.
  }, [watching, sender]);

  async function openFaucet() {
    if (!sender) return;
    const copied = await copyText(sender.address);
    window.open(FAUCET_PAGE_URL, "_blank", "noopener");
    setNotice(
      copied
        ? "Address copied. Paste it into the faucet page and request testnet SUI. This page will notice when it arrives."
        : "Copy your address above, paste it into the faucet page, and request testnet SUI.",
    );
    setWatching(true);
  }

  async function send() {
    if (!sender) return;
    const args = { to: recipient.trim(), amount: amount.trim() };
    setSending(true);
    setReceipt(null);
    setNotice(null);
    try {
      let amountMist: bigint;
      try {
        amountMist = parseToMist(args.amount);
      } catch {
        throw new Error(`Amount must be a positive SUI decimal string, for example "0.01". Got "${args.amount}".`);
      }
      if (passkey?.revoked) throw new Error("AI spending is locked. Unlock it with a passkey first.");
      if (amountMist > PASSKEY_THRESHOLD_MIST) {
        if (!passkey?.registered) throw new Error("Register a passkey before sending more than 0.1 SUI.");
        const proposalHash = await hashProposal({
          action: "transfer_sui",
          network: NETWORK,
          sender: sender.address,
          recipient: args.to,
          amountMist: amountMist.toString(),
        });
        const approval = await approveProposal(proposalHash);
        logCall({
          tool: "passkey_approval",
          args: { proposalHash, threshold: "0.1 SUI" },
          output: `Passkey approved proposal ${proposalHash}. Approval ${approval.approvalId}.`,
          isError: false,
        });
      }
      const result = await transferSui({
        client: client.current,
        signer: sender.keypair,
        recipient: args.to,
        amountMist,
      });
      setReceipt(result);
      logCall({ tool: "transfer_sui", args, output: formatTransferReceipt(result), isError: false });
      await refreshBalances(false);
    } catch (error) {
      logCall({ tool: "transfer_sui", args, output: errorMessage(error), isError: true });
      setNotice(errorMessage(error));
    } finally {
      setSending(false);
    }
  }

  function startOver() {
    const s = resetWallet("sender");
    const r = resetWallet("receiver");
    setSender(s);
    setReceiver(r);
    setRecipient(r.address);
    setSenderBalance(null);
    setReceiverBalance(null);
    setReceipt(null);
    setWatching(false);
    setCalls([]);
    setNotice("Created two new testnet wallets. The old ones are gone from this browser.");
  }

  async function enrollPasskey() {
    setPasskeyBusy(true);
    setNotice(null);
    try {
      await registerPasskey();
      const status = await getPasskeyStatus();
      setPasskey(status);
      setNotice("Passkey registered. A passkey is required for transfers above 0.1 SUI.");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function changeSpendingLock(revoked: boolean) {
    setPasskeyBusy(true);
    setNotice(null);
    try {
      if (!passkey?.registered) throw new Error("Register a passkey first.");
      const proposalHash = await hashProposal({
        action: revoked ? "revoke-ai-access" : "restore-ai-access",
        network: NETWORK,
        reason: revoked ? "Emergency lock" : "Owner unlock",
      });
      const approval = await approveProposal(proposalHash);
      await setPasskeyRevoked(approval.approvalId, proposalHash, revoked);
      setPasskey(await getPasskeyStatus());
      setNotice(revoked ? "AI spending is locked." : "AI spending is unlocked.");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setPasskeyBusy(false);
    }
  }

  const funded = senderBalance !== null && senderBalance > 0n;

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
          <h1>AI wallet on Sui</h1>
          <p className="lede">
            The same chain code the AI's MCP tools use, driven by buttons. Create a wallet, fund it, send SUI, and see
            what the model would see.
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

      <div className="grid">
        <section className="steps">
          <article className="card">
            <div className="card-head">
              <span className="step">1</span>
              <h2>Your wallets</h2>
            </div>
            <p className="muted">
              Two keypairs generated in this browser, like <code>npm run demo</code>. The secret keys never leave the
              page.
            </p>
            <WalletRow label="Sender" wallet={sender} balance={senderBalance} />
            <WalletRow label="Receiver" wallet={receiver} balance={receiverBalance} />
            <div className="actions">
              <button className="secondary" onClick={() => refreshBalances(true)} disabled={!sender || refreshing}>
                {refreshing ? "Refreshing…" : "Refresh balances"}
              </button>
              <button className="ghost" onClick={startOver}>
                New wallets
              </button>
            </div>
          </article>

          <article className="card">
            <div className="card-head">
              <span className="step">4</span>
              <h2>Passkey approval</h2>
            </div>
            <p className="muted">
              WebAuthn credentials stay in your device authenticator. Transfers above 0.1 SUI require user verification,
              and the emergency lock requires a passkey.
            </p>
            <div className="actions">
              <button onClick={enrollPasskey} disabled={passkeyBusy}>
                {passkeyBusy ? "Waiting…" : passkey?.registered ? "Register another device" : "Register passkey"}
              </button>
              <button
                className="secondary"
                onClick={() => changeSpendingLock(!passkey?.revoked)}
                disabled={passkeyBusy || !passkey?.registered}
              >
                {passkey?.revoked ? "Unlock AI spending" : "Emergency lock"}
              </button>
            </div>
            <p className="muted small">
              {passkey?.registered
                ? `${passkey.credentialCount} device${passkey.credentialCount === 1 ? "" : "s"} registered · ${
                    passkey.revoked ? "locked" : "active"
                  }`
                : "No passkey registered yet."}
            </p>
          </article>

          <article className="card">
            <div className="card-head">
              <span className="step">2</span>
              <h2>Get testnet SUI</h2>
            </div>
            <p className="muted">
              The faucet hands out free testnet SUI after a short proof-of-work. It opens in a new tab with your sender
              address on the clipboard.
            </p>
            <div className="actions">
              <button onClick={openFaucet} disabled={!sender}>
                Copy address and open faucet
              </button>
              {watching && (
                <span className="waiting">
                  <span className="dot" aria-hidden /> Waiting for SUI to arrive…
                </span>
              )}
              {!watching && funded && <span className="ok">Funded</span>}
            </div>
          </article>

          <article className="card">
            <div className="card-head">
              <span className="step">3</span>
              <h2>Send SUI</h2>
            </div>
            <p className="muted">
              Builds, signs, and submits a real testnet transfer. Defaults to your receiver wallet.
            </p>
            <label className="field">
              <span>To</span>
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                spellCheck={false}
                placeholder="0x…"
              />
            </label>
            <label className="field narrow">
              <span>Amount (SUI)</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            </label>
            <div className="actions">
              <button onClick={send} disabled={!sender || sending || !funded}>
                {sending ? "Sending…" : `Send ${amount || "0"} SUI`}
              </button>
              {!funded && <span className="muted small">Fund the sender first.</span>}
            </div>
            {receipt && (
              <div className="receipt">
                <p>
                  <strong>Sent {formatSui(receipt.amountMist)} SUI</strong>
                  {receipt.gasMist !== null && <> · gas {formatSui(receipt.gasMist)} SUI</>}
                </p>
                <a href={receipt.explorerUrl} target="_blank" rel="noreferrer">
                  View transaction on Suiscan ↗
                </a>
              </div>
            )}
          </article>
        </section>

        <aside className="card console">
          <div className="card-head">
            <h2>What the AI sees</h2>
          </div>
          <p className="muted">
            Each action is logged as the MCP tool call a model would make, with the exact text the tool returns.
          </p>
          {calls.length === 0 ? (
            <p className="empty">No tool calls yet.</p>
          ) : (
            <ol className="calls">
              {calls.map((call) => (
                <li key={call.id} className={call.isError ? "call error" : "call"}>
                  <div className="call-head">
                    <code className="tool">{call.tool}</code>
                    <span className="muted small">{call.at}</span>
                  </div>
                  <pre className="args">{JSON.stringify(call.args)}</pre>
                  <pre className="output">{call.output}</pre>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>

      <footer className="foot muted small">
        Signing happens in the page, so there is no policy check yet. That is the next phase in the design doc.
      </footer>
    </main>
  );
}

function WalletRow({ label, wallet, balance }: { label: string; wallet: DemoWallet | null; balance: bigint | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="wallet">
      <div>
        <p className="wallet-label">{label}</p>
        {wallet ? (
          <a className="mono" href={explorerAddressUrl(wallet.address)} target="_blank" rel="noreferrer" title={wallet.address}>
            {shortAddress(wallet.address)}
          </a>
        ) : (
          <span className="muted">Creating…</span>
        )}
      </div>
      <div className="wallet-side">
        <span className="balance">{balance === null ? "—" : `${formatSui(balance)} SUI`}</span>
        {wallet && (
          <button
            className="link"
            onClick={async () => {
              setCopied(await copyText(wallet.address));
              window.setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
    </div>
  );
}
