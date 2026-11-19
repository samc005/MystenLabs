import { passkeyStatus } from "@/lib/server/passkey";
import type Anthropic from "@anthropic-ai/sdk";
import { APIError } from "@anthropic-ai/sdk";
import { accountErrorResponse, requireAccount, type AccountContext } from "@/lib/server/account-context";
import { runChatTurn, type ChatEvent } from "@/lib/server/agent";
import { rejectNonLocal } from "@/lib/server/local-only";
import { consumeDaily, LimitError, limitsFromEnv } from "@/lib/server/usage";
import { ndjsonResponse } from "@/lib/ndjson";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;

  let account: AccountContext;
  try {
    account = await requireAccount(request);
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: "Could not load your account." }, { status: 500 });
  }

  const { messages } = (await request.json().catch(() => ({}))) as { messages?: Anthropic.Beta.BetaMessageParam[] };
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "Send the conversation as { messages: [...] }." }, { status: 400 });
  }

  try {
    const last = messages.at(-1);
    if (last?.role !== "user" || typeof last.content !== "string") throw new Error("Send a wallet command.");
    if (last.content.length > 2000) throw new Error("Request too long.");
    if ((await passkeyStatus()).revoked) throw new Error("Wallet access is locked.");
    // Chat only reads, proposes, and prepares unsigned bytes. Execution and
    // owner administration retain their own exact-action passkey checks.
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Policy refused." }, { status: 403 });
  }

  // Counted only once the request is valid, since each one spends the operator's Anthropic key.
  try {
    await consumeDaily(account.accountId, limitsFromEnv());
  } catch (error) {
    if (error instanceof LimitError) return Response.json({ error: error.message, code: "rate_limited" }, { status: 429 });
    return Response.json({ error: "Could not check the daily chat limit." }, { status: 500 });
  }

  return ndjsonResponse<ChatEvent>(async (send, signal) => {
    try {
      await runChatTurn(messages, send, signal, account);
    } catch (error) {
      if (signal.aborted) return;
      const message =
        error instanceof APIError ? `Claude API error ${error.status ?? ""}: ${error.message}` : error instanceof Error ? error.message : String(error);
      send({ type: "error", message });
    }
  }, request.signal);
}
