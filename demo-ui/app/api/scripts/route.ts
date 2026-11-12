// Runs one of wallet-mcp's npm scripts and streams its output. Only a fixed
// list of scripts is allowed, and only one runs at a time.

import { spawn } from "node:child_process";
import { rejectNonLocal } from "@/lib/server/local-only";
import { ndjsonResponse } from "@/lib/ndjson";
import { configuredWalletAddress, walletMcpDir } from "@/lib/server/wallet-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCRIPTS = {
  install: ["install"],
  build: ["run", "build"],
  balance: ["run", "balance"],
} as const satisfies Record<string, readonly string[]>;

export type ScriptName = keyof typeof SCRIPTS;

export type ScriptEvent =
  | { type: "start"; command: string }
  | { type: "log"; line: string; stream: "stdout" | "stderr" }
  | { type: "exit"; code: number | null };

let running: string | null = null;

export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;

  const { script } = (await request.json().catch(() => ({}))) as { script?: string };
  if (!script || !Object.hasOwn(SCRIPTS, script)) {
    return Response.json({ error: `Unknown script. Use one of: ${Object.keys(SCRIPTS).join(", ")}.` }, { status: 400 });
  }
  if (running) {
    return Response.json({ error: `npm ${running} is still running.` }, { status: 409 });
  }

  const address = script === "balance" ? configuredWalletAddress("sender") : undefined;
  if (script === "balance" && !address) {
    return Response.json({ error: "Set SUI_ADDRESS to the public testnet sender address." }, { status: 400 });
  }
  const args = SCRIPTS[script as ScriptName];
  const command = `npm ${args.join(" ")}`;
  running = args.join(" ");

  return ndjsonResponse<ScriptEvent>(async (send, signal) => {
    try {
      send({ type: "start", command });
      // These scripts only need build configuration and the public balance address.
      const env = {
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SystemRoot: process.env.SystemRoot,
        USERPROFILE: process.env.USERPROFILE,
      };
      const child = spawn("npm", address ? [...args, "--", address] : [...args], { cwd: walletMcpDir(), env, stdio: ["ignore", "pipe", "pipe"] });
      const onAbort = () => child.kill("SIGTERM");
      signal.addEventListener("abort", onAbort, { once: true });

      const pipe = (stream: NodeJS.ReadableStream, name: "stdout" | "stderr") => {
        let partial = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          const lines = (partial + chunk).split(/\r?\n/);
          partial = lines.pop() ?? "";
          for (const line of lines) send({ type: "log", line, stream: name });
        });
        stream.on("end", () => {
          if (partial) send({ type: "log", line: partial, stream: name });
        });
      };
      pipe(child.stdout, "stdout");
      pipe(child.stderr, "stderr");

      const code = await new Promise<number | null>((resolve) => {
        child.on("error", (error) => {
          send({ type: "log", line: error.message, stream: "stderr" });
          resolve(1);
        });
        child.on("close", resolve);
      });
      signal.removeEventListener("abort", onAbort);
      send({ type: "exit", code });
    } finally {
      running = null;
    }
  }, request.signal);
}
