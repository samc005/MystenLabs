import { createHash } from "node:crypto";
import { accountErrorResponse, requireAccount, type AccountContext } from "@/lib/server/account-context";
import { consumeApproval, passkeyStatus } from "@/lib/server/passkey";
import { rejectNonLocal } from "@/lib/server/local-only";
import { APPROVE_UNAVAILABLE, decideProposal, readProposal } from "@/lib/server/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function accountOrResponse(request: Request): Promise<AccountContext | Response> {
  try {
    return await requireAccount(request);
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: "Could not load your account." }, { status: 500 });
  }
}

export async function GET(request: Request, { params }: Context) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  const account = await accountOrResponse(request);
  if (account instanceof Response) return account;
  const { id } = await params;
  const proposal = await readProposal(id, account.proposalsDir);
  if (!proposal) return Response.json({ error: `No proposal ${id}.` }, { status: 404 });
  return Response.json({ proposal });
}

/**
 * Reject a proposal. Approving is not available yet: it has to be signed by the account's owner
 * wallet in the browser, and the chat agent has no tool that reaches it.
 */
export async function POST(request: Request, { params }: Context) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  const account = await accountOrResponse(request);
  if (account instanceof Response) return account;
  const { id } = await params;
  const { action, approvalId } = (await request.json().catch(() => ({}))) as { action?: string; approvalId?: string };
  if (action !== "approve" && action !== "reject") {
    return Response.json({ error: 'Send { "action": "approve" } or { "action": "reject" }.' }, { status: 400 });
  }
  // Refuse before a passkey approval is consumed, so a refused action wastes nothing.
  if (action === "approve") return Response.json({ error: APPROVE_UNAVAILABLE }, { status: 501 });
  try {
    if ((await passkeyStatus()).revoked) throw new Error("Wallet access is locked.");
    const proposal = await readProposal(id, account.proposalsDir);
    if (!proposal || !approvalId) throw new Error("Passkey approval required.");
    const hash = createHash("sha256").update(JSON.stringify({ action: "proposal-decision", id, decision: action, proposal })).digest("hex");
    await consumeApproval(approvalId, hash);
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 403 });
  }
  const result = await decideProposal(id, action, account);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ proposal: result.proposal });
}
