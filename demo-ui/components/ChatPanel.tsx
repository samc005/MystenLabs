"use client";

import type Anthropic from "@anthropic-ai/sdk";
import { useEffect, useRef, useState } from "react";
import { readNdjson } from "@/lib/ndjson";
import type { ChatEvent } from "@/lib/server/agent";

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; output?: string; isError?: boolean }
  | { kind: "error"; text: string };

const SUGGESTIONS = [
  "What's my balance?",
  "Send 0.01 SUI to the receiver",
  "How much does the receiver have now?",
];

interface Props {
  /** Called after every tool result, so the wallet panel can refresh. */
  onToolResult: () => void;
}

export function ChatPanel({ onToolResult }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<Anthropic.Beta.BetaMessageParam[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

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

  function reset() {
    abortRef.current?.abort();
    setItems([]);
    setHistory([]);
  }

  return (
    <section className="card chat">
      <div className="card-head spread">
        <h2>Chat with Claude</h2>
        <button className="ghost small-btn" onClick={reset} disabled={items.length === 0}>
          New chat
        </button>
      </div>

      <div className="chat-log" ref={scrollRef}>
        {items.length === 0 && (
          <div className="chat-empty">
            <p className="muted">Ask in plain English. Claude can only act through the wallet-mcp tools.</p>
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
          return (
            <div key={item.id} className={item.isError ? "tool-card error" : "tool-card"}>
              <div className="tool-card-head">
                <span className="tool-badge">MCP tool</span>
                <code className="tool">{item.name}</code>
                {pending && <span className="dot" aria-label="Running" />}
              </div>
              <pre className="args">{JSON.stringify(item.input)}</pre>
              {!pending && <pre className="output">{item.output}</pre>}
            </div>
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
          placeholder="e.g. Send 0.02 SUI to the receiver"
          disabled={busy}
          aria-label="Message Claude"
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
