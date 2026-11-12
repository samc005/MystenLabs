import { rejectNonLocal } from "@/lib/server/local-only";
import { decideProposal, readProposal } from "@/lib/server/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  const { id } = await params;
  const proposal = await readProposal(id);
  if (!proposal) return Response.json({ error: `No proposal ${id}.` }, { status: 404 });
  return Response.json({ proposal });
}

/**
 * Approve or reject. Approve signs create_intent on-chain with the exact terms stored in
 * the proposal. This is the only way a swap becomes possible, and the chat agent has no
 * tool that reaches it.
 */
export async function POST(request: Request, { params }: Context) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  const { id } = await params;
  const { action } = (await request.json().catch(() => ({}))) as { action?: string };
  if (action !== "approve" && action !== "reject") {
    return Response.json({ error: 'Send { "action": "approve" } or { "action": "reject" }.' }, { status: 400 });
  }
  const result = await decideProposal(id, action);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ proposal: result.proposal });
}
