"use client";

import { useEffect, useRef, useState } from "react";
import { readNdjson } from "@/lib/ndjson";
import type { ScriptEvent, ScriptName } from "@/app/api/scripts/route";

const BUTTONS: { script: ScriptName; label: string; hint: string }[] = [
  { script: "balance", label: "npm run balance", hint: "Print balances for the configured public sender address." },
  { script: "install", label: "npm install", hint: "Install wallet-mcp dependencies." },
  { script: "build", label: "npm run build", hint: "Build the MCP server Cipher talks to." },
];

interface Props {
  onFinished: () => void;
}

interface LogLine {
  text: string;
  kind: "cmd" | "stdout" | "stderr" | "exit";
}

export function ScriptRunner({ onFinished }: Props) {
  const [running, setRunning] = useState<ScriptName | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  async function run(script: ScriptName) {
    setRunning(script);
    setLines([]);
    try {
      const response = await fetch("/api/scripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script }),
      });
      if (!response.ok) {
        const { error } = (await response.json().catch(() => ({}))) as { error?: string };
        setLines([{ text: error ?? `Request failed (${response.status})`, kind: "stderr" }]);
        return;
      }
      await readNdjson<ScriptEvent>(response, (event) => {
        const line: LogLine =
          event.type === "start"
            ? { text: `$ ${event.command}`, kind: "cmd" }
            : event.type === "log"
              ? { text: event.line, kind: event.stream }
              : { text: event.code === 0 ? "✓ done" : `✗ exited with code ${event.code}`, kind: "exit" };
        setLines((previous) => [...previous, line]);
      });
    } catch (error) {
      setLines((previous) => [...previous, { text: error instanceof Error ? error.message : String(error), kind: "stderr" }]);
    } finally {
      setRunning(null);
      onFinished();
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>wallet-mcp scripts</h2>
      </div>
      <p className="muted">The same npm scripts you would run in a terminal, run in the wallet-mcp folder.</p>
      <div className="script-buttons">
        {BUTTONS.map(({ script, label, hint }) => (
          <button
            key={script}
            className="secondary"
            title={hint}
            onClick={() => run(script)}
            disabled={running !== null}
          >
            {running === script ? `${label}…` : label}
          </button>
        ))}
      </div>
      {lines.length > 0 && (
        <pre className="terminal" ref={logRef}>
          {lines.map((line, i) => (
            <span key={i} className={`term-${line.kind}`}>
              {line.text}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
    </section>
  );
}
