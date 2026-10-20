import type Anthropic from "@anthropic-ai/sdk";
import { APIError } from "@anthropic-ai/sdk";
import { runChatTurn, type ChatEvent } from "@/lib/server/agent";
import { rejectNonLocal } from "@/lib/server/local-only";
import { ndjsonResponse } from "@/lib/ndjson";
import { walletMcpStatus } from "@/lib/server/wallet-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;

  const status = walletMcpStatus();
  if (!status.apiKey) {
    return Response.json({ error: "ANTHROPIC_API_KEY is not set. Add it to demo-ui/.env.local and restart." }, { status: 400 });
  }
  if (!status.built) {
    return Response.json({ error: "wallet-mcp is not built yet. Run npm install and npm run build from the panel." }, { status: 400 });
  }

  const { messages } = (await request.json().catch(() => ({}))) as { messages?: Anthropic.Beta.BetaMessageParam[] };
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "Send the conversation as { messages: [...] }." }, { status: 400 });
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
