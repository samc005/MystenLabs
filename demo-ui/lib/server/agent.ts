import { randomUUID } from "node:crypto";
import { resolveMessage } from "./wallet-intent";
// The chat demo's agent loop: Claude on the Messages API, with tools that come
// from the real wallet-mcp server. The server is started over stdio exactly as
// Claude Code would start it from .mcp.json, and every tool call goes through it.

import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mcpEnvFor, type AccountContext } from "./account-context";
import { walletMcpDir, walletMcpEntry } from "./wallet-mcp";

import { parseWalletCommand, assertToolAction, LOCAL_TOOLS } from "@/lib/wallet-policy";
import type { OwnerAction } from "@/lib/owner-actions";
import type { PaymentRequestView } from "@/lib/payment-request";
import { contactsFor, labelsFor } from "./account-store";
import { handleLocalAction, topUpAndPayFor, topUpFor } from "./local-actions";
import { rememberPrepared } from "./wallet-execution";
import { cleanToolText, friendlyRefusal, leadFor, presentBalance, presentVault } from "./chat-presenter";
import { readVaultPolicy, type PolicyReader } from "@/lib/owner-tx";
import { createSuiClient } from "@/lib/sui";
import { validatorNamesFor } from "./validators";

/** The proposal ID when wallet-mcp says the owner's standing rule already covers this swap. */
export function autoSwapProposal(output: string): string | null {
  if (!/standing trade rule already covers this swap/.test(output)) return null;
  return output.match(/Proposal ID: (prop_[0-9a-f]{10})/)?.[1] ?? null;
}

/** What the user reads in chat for a wallet result. Falls back to the cleaned tool text. */
async function presentResult(tool: string, output: string, isError: boolean, prepared: boolean, account: AccountContext): Promise<string> {
  if (isError) {
    const labels = await labelsFor(account.accountId).catch(() => ({}));
    const reason = friendlyRefusal(output, labels).replace(/\s*Nothing (was|has been) (sent|traded|signed)[^.]*\./gi, "").trim();
    return `That didn't go through. ${reason || "The wallet refused it."} Nothing was sent.`;
  }
  try {
    if (tool === "get_balance") return await presentBalance(account);
    if (tool === "vault_status") return await presentVault(account);
  } catch {
    // Fall through to the tool's own text, which has the same facts.
  }
  const lead = leadFor(tool, prepared);
  if (prepared) return lead!;
  const body = cleanToolText(output);
  return lead ? `${lead}\n${body}` : body;
}

export type ChatEvent =
  | { type: "text"; delta: string }
  /** Plain-text reply: a clarifying question or a general answer. Never an action. */
  | { type: "reply"; text: string; disclaimer: string | null }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError: boolean }
  | { type: "prepared"; id: string; command: string; summary: string }
  /** An owner action for the user's own wallet to sign in the browser. The server cannot sign it. */
  | { type: "owner_action"; action: OwnerAction }
  /** A payment request the user can share as a QR code or link. */
  | { type: "payment_request"; request: PaymentRequestView }
  | { type: "done"; messages: Anthropic.Beta.BetaMessageParam[] }
  | { type: "error"; message: string };

/**
 * Starts the wallet-mcp server for one account. The vault, agent address and proposals directory
 * come from the account record. Nothing vault-related is read from this process's environment,
 * so there is no way to fall back to a shared vault.
 */
export async function connectWalletMcp(account: AccountContext): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [walletMcpEntry()],
    cwd: walletMcpDir(),
    env: {
      ...getDefaultEnvironment(),
      SUI_SIGNER_PORT: process.env.SUI_SIGNER_PORT ?? "38435",
      SUI_SIGNER_TOKEN: process.env.SUI_SIGNER_TOKEN ?? "",
      SUI_ENABLE_DIRECT_TRANSFER: "",
      // The trading pool is shared infrastructure, not per-account state.
      ...Object.fromEntries(
        ["SUI_POOL_PACKAGE_ID", "SUI_POOL_ID"].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
      ),
      ...mcpEnvFor(account),
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
  account: AccountContext,
): Promise<void> {
  const last = history.at(-1);
  if (!last || last.role !== "user" || typeof last.content !== "string") throw new Error("Send a wallet command.");
  const contacts = await contactsFor(account.accountId);
  // Approved validators by name, so "stake 1 SUI with Mysten 1" works. Only looked up for staking.
  const validators = /\bstak/i.test(last.content)
    ? await readVaultPolicy(createSuiClient() as unknown as PolicyReader, account.vaultId)
        .then((policy) => validatorNamesFor(policy.allowedValidators ?? []))
        .catch(() => ({}))
    : {};
  const resolved = await resolveMessage(last.content, signal, contacts, validators);
  if (resolved.kind === "reply") {
    send({ type: "reply", text: resolved.text, disclaimer: resolved.disclaimer });
    send({ type: "done", messages: [] });
    return;
  }
  let command = resolved.command;
  let action = parseWalletCommand(command);
  if (LOCAL_TOOLS.has(action.tool)) {
    await handleLocalAction(action, account, send);
    send({ type: "done", messages: [] });
    return;
  }
  const mcp = await connectWalletMcp(account);
  try {
    assertToolAction(action, action.tool, action.args);
    const toolId = randomUUID();
    send({ type: "tool_call", id: toolId, name: action.tool, input: action.args });
    let result = await mcp.callTool({ name: action.tool, arguments: action.args });
    let output = toolResultText(result);
    send({ type: "tool_result", id: toolId, output, isError: Boolean(result.isError) });
    // A swap the owner's standing rule already covers needs no owner approval: prepare it right
    // away so the user confirms it with their passkey in the same turn. The contract re-checks
    // the rule when it runs.
    const auto = action.tool === "propose_trade" && !result.isError ? autoSwapProposal(output) : null;
    if (auto) {
      command = `execute swap ${auto}`;
      action = parseWalletCommand(command);
      assertToolAction(action, action.tool, action.args);
      result = await mcp.callTool({ name: action.tool, arguments: action.args });
      output = toolResultText(result);
    }
    const structured = result.structuredContent as { transactionBytes?: unknown } | undefined;
    if (!result.isError && typeof structured?.transactionBytes === "string") {
      const simulation = await mcp.callTool({ name: "estimate_gas", arguments: { transactionBase64: structured.transactionBytes } });
      if (simulation.isError) throw new Error("Simulation failed. Nothing was signed or submitted.");
      output += "\n" + toolResultText(simulation);
      const id = rememberPrepared(account.accountId, command, structured.transactionBytes, output, action.note);
      send({ type: "prepared", id, command, summary: output });
    }
    const payWithTopUp = result.isError ? topUpAndPayFor(toolResultText(result), action, contacts) : null;
    if (payWithTopUp) {
      send({ type: "text", delta: payWithTopUp.text });
      send({ type: "owner_action", action: payWithTopUp.action });
      send({ type: "done", messages: [] });
      return;
    }
    const topUp = result.isError ? topUpFor(toolResultText(result)) : null;
    if (topUp) {
      send({ type: "text", delta: topUp.text });
      send({ type: "owner_action", action: { kind: "deposit", amountMist: topUp.amountMist } });
      send({ type: "done", messages: [] });
      return;
    }
    send({ type: "text", delta: await presentResult(action.tool, toolResultText(result), Boolean(result.isError), typeof structured?.transactionBytes === "string", account) });
    send({ type: "done", messages: [] });
  } finally {
    await mcp.close().catch(() => undefined);
  }
}
