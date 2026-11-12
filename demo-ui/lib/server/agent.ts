import { randomUUID } from "node:crypto";
import { resolveWalletCommand } from "./wallet-intent";
// The chat demo's agent loop: Claude on the Messages API, with tools that come
// from the real wallet-mcp server. The server is started over stdio exactly as
// Claude Code would start it from .mcp.json, and every tool call goes through it.

import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { walletMcpDir, walletMcpEntry } from "./wallet-mcp";

import { parseWalletCommand, assertToolAction } from "@/lib/wallet-policy";
import { rememberPrepared } from "./wallet-execution";

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError: boolean }
  | { type: "prepared"; id: string; command: string; summary: string }
  | { type: "done"; messages: Anthropic.Beta.BetaMessageParam[] }
  | { type: "error"; message: string };

export async function connectWalletMcp(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [walletMcpEntry()],
    cwd: walletMcpDir(),
    env: {
      ...getDefaultEnvironment(),
      SUI_NETWORK: "testnet",
      SUI_ADDRESS: process.env.SUI_ADDRESS ?? "",
      SUI_SIGNER_PORT: process.env.SUI_SIGNER_PORT ?? "38435",
      SUI_SIGNER_TOKEN: process.env.SUI_SIGNER_TOKEN ?? "",
      SUI_ENABLE_DIRECT_TRANSFER: "",
      ...Object.fromEntries([
        "SUI_VAULT_PACKAGE_ID", "SUI_VAULT_ID", "SUI_VAULT_AGENT_CAP_ID",
        "SUI_POOL_PACKAGE_ID", "SUI_POOL_ID", "SUI_PROPOSALS_DIR",
      ].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])),
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "demo-ui", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function toolResultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
    .filter(Boolean)
    .join("\n");
  return text;
}

/**
 * Runs one user turn to completion. `history` is the previous conversation as
 * returned in the last `done` event, with the new user message appended.
 */
export async function runChatTurn(
  history: Anthropic.Beta.BetaMessageParam[],
  send: (event: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const last = history.at(-1);
  if (!last || last.role !== "user" || typeof last.content !== "string") throw new Error("Send a wallet command.");
  const command = await resolveWalletCommand(last.content, signal);
  const action = parseWalletCommand(command);
  const mcp = await connectWalletMcp();
  try {
    assertToolAction(action, action.tool, action.args);
    const toolId = randomUUID();
    send({ type: "tool_call", id: toolId, name: action.tool, input: action.args });
    const result = await mcp.callTool({ name: action.tool, arguments: action.args });
    let output = toolResultText(result);
    send({ type: "tool_result", id: toolId, output, isError: Boolean(result.isError) });
    const structured = result.structuredContent as { transactionBytes?: unknown } | undefined;
    if (!result.isError && typeof structured?.transactionBytes === "string") {
      const simulation = await mcp.callTool({ name: "estimate_gas", arguments: { transactionBase64: structured.transactionBytes } });
      if (simulation.isError) throw new Error("Simulation failed. Nothing was signed or submitted.");
      output += "\n" + toolResultText(simulation);
      const id = rememberPrepared(command, structured.transactionBytes, output);
      send({ type: "prepared", id, command, summary: output });
    }
    send({ type: "text", delta: output });
    send({ type: "done", messages: [] });
  } finally {
    await mcp.close().catch(() => undefined);
  }
}
