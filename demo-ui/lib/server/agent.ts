// The chat demo's agent loop: Claude on the Messages API, with tools that come
// from the real wallet-mcp server. The server is started over stdio exactly as
// Claude Code would start it from .mcp.json, and every tool call goes through it.

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { formatSui } from "@/lib/sui";
import { listLocalWallets, walletMcpDir, walletMcpEntry } from "./wallet-mcp";

const MODEL = "claude-opus-5-5";
const MAX_TURNS = 8;

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError: boolean }
  | { type: "done"; messages: Anthropic.Beta.BetaMessageParam[] }
  | { type: "error"; message: string };

async function connectWalletMcp(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [walletMcpEntry()],
    cwd: walletMcpDir(),
    env: { ...getDefaultEnvironment(), SUI_NETWORK: "testnet" },
    stderr: "ignore",
  });
  const client = new Client({ name: "demo-ui", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function systemPrompt(): Promise<string> {
  const wallets = await listLocalWallets();
  const known = wallets.length
    ? wallets
        .map((w) => {
          const balance = w.balanceMist === null ? "balance unknown" : `${formatSui(BigInt(w.balanceMist))} SUI`;
          return `- ${w.role}: ${w.address} (${balance} when this conversation turn started)`;
        })
        .join("\n")
    : "- none yet. Tell the user to run npm run setup from the panel.";
  return [
    "You are the assistant in a live demo of an AI wallet on the Sui testnet. Testnet coins have no value.",
    "You act only through the wallet tools. get_balance reads the chain. transfer_sui sends SUI from the local sender wallet and cannot be undone.",
    "Always call get_balance for balance questions instead of relying on numbers in this prompt.",
    "Send only when the user names an amount and a recipient. The user can refer to the local wallets by role:",
    known,
    "Never invent an address. If a request is ambiguous, ask one short question instead of sending.",
    "Keep replies to one to three short sentences and include the explorer link after a transfer.",
  ].join("\n");
}

function toolResultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
    .filter(Boolean)
    .join("\n");
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
  const anthropic = new Anthropic();
  const mcp = await connectWalletMcp();
  const messages = [...history];
  try {
    const { tools: mcpTools } = await mcp.listTools();
    const tools: Anthropic.Beta.BetaTool[] = mcpTools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      eager_input_streaming: true,
    }));
    const system = await systemPrompt();
    let jsonRetries = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = anthropic.beta.messages.stream(
        {
          model: MODEL,
          max_tokens: 64000,
          system,
          tools,
          messages,
          output_config: { effort: "low" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal },
      );
      stream.on("text", (delta) => send({ type: "text", delta }));

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (error) {
        // Eager input streaming can leave a tool input unparseable. Re-issue
        // that turn a couple of times; real API errors go to the caller.
        if (error instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= 2) throw error;
        continue;
      }

      messages.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "refusal") {
        send({ type: "text", delta: "\n\n(Claude declined this request.)" });
        break;
      }
      if (message.stop_reason === "pause_turn") continue;

      const toolUses = message.content.filter(
        (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
      );
      if (toolUses.length === 0) break;
      if (message.stop_reason === "max_tokens") {
        throw new Error("Claude's reply was cut off before the tool call finished.");
      }

      // wallet-mcp validates every input with its own zod schema and returns
      // isError on a bad one, so the model gets the same feedback a CLI client would.
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of toolUses) {
        send({ type: "tool_call", id: use.id, name: use.name, input: use.input });
        let output: string;
        let isError: boolean;
        if (!use.input || typeof use.input !== "object" || Array.isArray(use.input)) {
          output = "Tool input was not a JSON object.";
          isError = true;
        } else {
          try {
            const result = await mcp.callTool({ name: use.name, arguments: use.input as Record<string, unknown> });
            output = toolResultText(result) || "(no output)";
            isError = Boolean(result.isError);
          } catch (error) {
            output = error instanceof Error ? error.message : String(error);
            isError = true;
          }
        }
        send({ type: "tool_result", id: use.id, output, isError });
        results.push({ type: "tool_result", tool_use_id: use.id, content: output, is_error: isError });
      }
      messages.push({ role: "user", content: results });
    }

    send({ type: "done", messages });
  } finally {
    await mcp.close().catch(() => undefined);
  }
}
