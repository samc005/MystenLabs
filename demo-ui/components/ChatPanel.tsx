"use client";

import type Anthropic from "@anthropic-ai/sdk";
import { Fragment, useEffect, useRef, useState } from "react";
import { readNdjson } from "@/lib/ndjson";
import type { ChatEvent } from "@/lib/server/agent";
import { approveProposal, getPasskeyStatus, hashProposal, registerPasskey } from "@/lib/passkey";
import { isSpendProposal } from "@/lib/proposals";
import { ProposalCard } from "./ProposalCard";

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; output?: string; isError?: boolean }
  | { kind: "error"; text: string };

const SUGGESTIONS = [
  "What's my balance?",
  "vault status",
  "balance",
  "validators",
];

const PROPOSAL_ID = /Proposal ID: (prop_[0-9a-f]{10})/;

interface Props {
  /** Called after every tool result, so the wallet panel can refresh. */
  onToolResult: () => void;
}

export function ChatPanel({ onToolResult }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<Anthropic.Beta.BetaMessageParam[]>([]);
  const [input, setInput] = useState("");
  const [prepared, setPrepared] = useState<{ id: string; command: string } | null>(null);
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
      if (!(await getPasskeyStatus()).registered) await registerPasskey();
      const { approvalId } = await approveProposal(await hashProposal({ action: "wallet-command", command: prompt }));
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, approvalId }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const { error } = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(error ?? `Request failed (${response.status})`);
      }
      await readNdjson<ChatEvent>(response, (event) => {
        switch (event.type) {
          case "prepared":
            setPrepared({ id: event.id, command: event.command });
            break;
          case "text":
            appendText(event.delta);
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
      const { approvalId } = await approveProposal(await hashProposal({ action: "execute-wallet-command", ...prepared }));
      const response = await fetch("/api/wallet/execute", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: prepared.id, approvalId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? JSON.stringify(result.content));
      appendText(JSON.stringify(result.content));
      onToolResult();
    } catch (error) {
      setItems(previous => [...previous, { kind: "error", text: String(error) }]);
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
        <button className="ghost small-btn" onClick={reset} disabled={items.length === 0}>
          New chat
        </button>
      </div>

      {prepared && <div className="card">
        <p>Confirm testnet transaction: {prepared.command}</p>
        <button onClick={execute} disabled={busy}>Approve with passkey and execute</button>
        <button onClick={() => setPrepared(null)} disabled={busy}>Cancel</button>
      </div>}
      <div className="chat-log" ref={scrollRef}>
        {items.length === 0 && (
          <div className="chat-empty">
            <p className="muted">Ask for one wallet action. Confirm the exact transaction before spending.</p>
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
          if (item.kind === "assistant") return <div key={i} className="bubble assistant">{item.text}</div>;
          if (item.kind === "error") return <div key={i} className="bubble error">{item.text}</div>;
          const pending = item.output === undefined;
          const proposalId = (item.name === "propose_trade" || item.name === "propose_spend") && !item.isError ? item.output?.match(PROPOSAL_ID)?.[1] : undefined;
          return (
            <Fragment key={item.id}>
              <div className={item.isError ? "tool-card error" : "tool-card"}>
                <div className="tool-card-head">
                  <span className="tool-badge">MCP tool</span>
                  <code className="tool">{item.name}</code>
                  {pending && <span className="dot" aria-label="Running" />}
                </div>
                <pre className="args">{JSON.stringify(item.input)}</pre>
                {!pending && <pre className="output">{item.output}</pre>}
              </div>
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
          placeholder="e.g. Swap 0.05 SUI to tUSDC"
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
