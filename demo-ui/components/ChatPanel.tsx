"use client";

import type Anthropic from "@anthropic-ai/sdk";
import { Fragment, useEffect, useRef, useState } from "react";
import { readNdjson } from "@/lib/ndjson";
import type { ChatEvent } from "@/lib/server/agent";
import { approveProposal, getPasskeyStatus, hashProposal, registerPasskey } from "@/lib/passkey";
import { isSpendProposal } from "@/lib/proposals";
import { ProposalCard } from "./ProposalCard";
import { RichText } from "./RichText";
import { OwnerActionCard } from "./OwnerActionCard";
import { PaymentRequestCard } from "./PaymentRequestCard";
import type { PaymentRequestView } from "@/lib/payment-request";
import type { OwnerAction } from "@/lib/owner-actions";
import { TOOL_WORKING } from "@/lib/display";

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; disclaimer?: string | null }
  | { kind: "tool"; id: string; name: string; input: unknown; output?: string; isError?: boolean }
  | { kind: "owner_action"; action: OwnerAction }
  | { kind: "payment_request"; request: PaymentRequestView }
  | { kind: "error"; text: string };

const SUGGESTIONS = [
  "How much do I have?",
  "What are my spending limits?",
  "How much tUSDC would I get for 0.1 SUI?",
  "What is staking?",
];

const PROPOSAL_ID = /Proposal ID: (prop_[0-9a-f]{10})/;

interface Props {
  /** Called after every tool result, so the wallet panel can refresh. */
  onToolResult: () => void;
  /** Friendly names for addresses (your wallet, vault, Cipher, contacts), keyed lowercase. */
  labels: Record<string, string>;
}

/** The text parts of an MCP tool result. */
function resultText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text) : ""))
    .filter(Boolean)
    .join("\n");
}

export function ChatPanel({ onToolResult, labels }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<Anthropic.Beta.BetaMessageParam[]>([]);
  const [input, setInput] = useState("");
  const [prepared, setPrepared] = useState<{ id: string; command: string; summary: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // A message to send as soon as the current turn ends (e.g. "I approved it" clicked mid-reply).
  const [queued, setQueued] = useState<string | null>(null);

  useEffect(() => {
    if (!busy && queued) {
      const next = queued;
      setQueued(null);
      void send(next);
    }
  });

  function followUp(text: string) {
    if (busy) setQueued(text);
    else void send(text);
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [items]);

  function appendText(delta: string) {
    setItems((previous) => {
      const last = previous[previous.length - 1];
      if (last?.kind === "assistant") {
        return [...previous.slice(0, -1), { ...last, text: last.text + delta }];
      }
      return [...previous, { kind: "assistant", text: delta }];
    });
  }

  async function send(text: string) {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setInput("");
    setBusy(true);
    setItems((previous) => [...previous, { kind: "user", text: prompt }]);

    const messages: Anthropic.Beta.BetaMessageParam[] = [...history, { role: "user", content: prompt }];
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const { error } = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(error ?? `Request failed (${response.status})`);
      }
      await readNdjson<ChatEvent>(response, (event) => {
        switch (event.type) {
          case "prepared":
            setPrepared({ id: event.id, command: event.command, summary: event.summary });
            break;
          case "text":
            appendText(event.delta);
            break;
          case "payment_request":
            setItems((previous) => [...previous, { kind: "payment_request", request: event.request }]);
            break;
          case "owner_action":
            setItems((previous) => [...previous, { kind: "owner_action", action: event.action }]);
            break;
          case "reply":
            setItems((previous) => [...previous, { kind: "assistant", text: event.text, disclaimer: event.disclaimer }]);
            break;
          case "tool_call":
            setItems((previous) => [...previous, { kind: "tool", id: event.id, name: event.name, input: event.input }]);
            break;
          case "tool_result":
            setItems((previous) =>
              previous.map((item) =>
                item.kind === "tool" && item.id === event.id ? { ...item, output: event.output, isError: event.isError } : item,
              ),
            );
            onToolResult();
            break;
          case "done":
            setHistory(event.messages);
            break;
          case "error":
            setItems((previous) => [...previous, { kind: "error", text: event.message }]);
            break;
        }
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setItems((previous) => [...previous, { kind: "error", text: error instanceof Error ? error.message : String(error) }]);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  async function execute() {
    if (!prepared || busy) return;
    setBusy(true);
    try {
      if (!(await getPasskeyStatus()).registered) await registerPasskey();
      const { approvalId } = await approveProposal(await hashProposal({ action: "execute-wallet-command", ...prepared }));
      const response = await fetch("/api/wallet/execute", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: prepared.id, approvalId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? (resultText(result) || "Execution failed."));
      const receipt = (resultText(result) || "Done.").replace(/^Confirmed proposal [0-9a-f-]{36}\./m, "Sent and confirmed on chain.");
      setItems((previous) => [...previous, { kind: "assistant", text: receipt }]);
      onToolResult();
    } catch (error) {
      setItems((previous) => [...previous, { kind: "error", text: error instanceof Error ? error.message : String(error) }]);
    } finally { setPrepared(null); setBusy(false); }
  }

  function reset() {
    setPrepared(null);
    abortRef.current?.abort();
    setItems([]);
    setHistory([]);
  }

  return (
    <section className="card chat">
      <div className="card-head spread">
        <h2>Cipher</h2>
        <a href="/passkeys">Manage passkeys / recovery</a>
        <button className="ghost small-btn" onClick={reset} disabled={items.length === 0}>
          New chat
        </button>
      </div>

      <div className="chat-log" ref={scrollRef}>
        {items.length === 0 && (
          <div className="chat-empty">
            <p className="muted">
              Ask in your own words: check balances, send, swap or stake, or ask a money question. You confirm every
              transaction before anything is sent.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="secondary small-btn" onClick={() => send(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {items.map((item, i) => {
          if (item.kind === "user") return <div key={i} className="bubble user">{item.text}</div>;
          if (item.kind === "assistant") {
            return (
              <div key={i} className="bubble assistant">
                <RichText text={item.text} labels={labels} />
                {item.disclaimer && <p className="disclaimer">{item.disclaimer}</p>}
              </div>
            );
          }
          if (item.kind === "payment_request") return <PaymentRequestCard key={i} request={item.request} />;
          if (item.kind === "owner_action") return <OwnerActionCard key={i} action={item.action} onDone={onToolResult} />;
          if (item.kind === "error") return <div key={i} className="bubble error">{item.text}</div>;
          const pending = item.output === undefined;
          const proposalId = (item.name === "propose_trade" || item.name === "propose_spend") && !item.isError ? item.output?.match(PROPOSAL_ID)?.[1] : undefined;
          return (
            <Fragment key={item.id}>
              {/* The reply that follows says what happened; only show progress while it runs. */}
              {pending && (
                <div className="bubble assistant thinking">
                  <span className="dot" /> {TOOL_WORKING[item.name] ?? "Working on it…"}
                </div>
              )}
              {proposalId && (
                <ProposalCard
                  id={proposalId}
                  onApproved={(p) => followUp("execute " + (isSpendProposal(p) ? "payment " : "swap ") + p.id)}
                  onRejected={() => appendText("Proposal rejected. Nothing executed.")}
                />
              )}
            </Fragment>
          );
        })}

        {busy && items[items.length - 1]?.kind === "user" && (
          <div className="bubble assistant thinking">
            <span className="dot" /> Thinking…
          </div>
        )}
      </div>

      {prepared && (
        <div className="confirm-card">
          <div>
            <strong>Confirm this testnet transaction</strong>
            <RichText text={prepared.command} labels={labels} />
          </div>
          <details>
            <summary>Details and simulation</summary>
            <RichText text={prepared.summary} labels={labels} />
          </details>
          <div className="actions">
            <button onClick={execute} disabled={busy}>
              Approve with passkey and send
            </button>
            <button className="ghost" onClick={() => setPrepared(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. send 0.05 sui to Friend, or what's my balance?"
          disabled={busy}
          aria-label="Message Cipher"
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
