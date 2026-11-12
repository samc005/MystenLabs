import { createHash } from "node:crypto";
import { consumeApproval, passkeyStatus } from "@/lib/server/passkey";
import type Anthropic from "@anthropic-ai/sdk";
import { APIError } from "@anthropic-ai/sdk";
import { runChatTurn, type ChatEvent } from "@/lib/server/agent";
import { rejectNonLocal } from "@/lib/server/local-only";
import { ndjsonResponse } from "@/lib/ndjson";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;

  const { messages, approvalId } = (await request.json().catch(() => ({}))) as { messages?: Anthropic.Beta.BetaMessageParam[]; approvalId?: string };
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "Send the conversation as { messages: [...] }." }, { status: 400 });
  }

  try {
    const last = messages.at(-1);
    if (last?.role !== "user" || typeof last.content !== "string") throw new Error("Send a wallet command.");
    if (last.content.length > 2000) throw new Error("Request too long.");
    if ((await passkeyStatus()).revoked) throw new Error("Wallet access is locked.");
    if (!approvalId) throw new Error("Passkey authentication required.");
    const hash = createHash("sha256").update(JSON.stringify({ action: "wallet-command", command: last.content })).digest("hex");
    await consumeApproval(approvalId, hash);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Policy refused." }, { status: 403 });
  }

  return ndjsonResponse<ChatEvent>(async (send, signal) => {
    try {
      await runChatTurn(messages, send, signal);
    } catch (error) {
      if (signal.aborted) return;
      const message =
        error instanceof APIError ? `Claude API error ${error.status ?? ""}: ${error.message}` : error instanceof Error ? error.message : String(error);
      send({ type: "error", message });
    }
  }, request.signal);
}
