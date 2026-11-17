import { createHash } from "node:crypto";
import { consumeApproval, passkeyStatus } from "@/lib/server/passkey";
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
  const { action, approvalId } = (await request.json().catch(() => ({}))) as { action?: string; approvalId?: string };
  if (action !== "approve" && action !== "reject") {
    return Response.json({ error: 'Send { "action": "approve" } or { "action": "reject" }.' }, { status: 400 });
  }
  try {
    if ((await passkeyStatus()).revoked) throw new Error("Wallet access is locked.");
    const proposal = await readProposal(id);
    if (!proposal || !approvalId) throw new Error("Passkey approval required.");
    const hash = createHash("sha256").update(JSON.stringify({ action: "proposal-decision", id, decision: action, proposal })).digest("hex");
    await consumeApproval(approvalId, hash);
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 403 });
  }
  const result = await decideProposal(id, action);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ proposal: result.proposal });
}
