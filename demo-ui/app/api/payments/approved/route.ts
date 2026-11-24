import { accountErrorResponse, requireAccount } from "@/lib/server/account-context";
import { NOTE } from "@/lib/server/account-store";
import { rejectNonLocal } from "@/lib/server/local-only";
import { sendOwnerApprovedPayment } from "@/lib/server/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sends a payment the owner just approved in one step (top up the vault + approve this payment).
 * Only the digest and passkey approval come from the browser; recipient and amount are read from
 * the owner's transaction on-chain and must match what the passkey approved.
 */
export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const account = await requireAccount(request);
    const body = (await request.json().catch(() => ({}))) as { digest?: unknown; approvalId?: unknown; note?: unknown };
    if (typeof body.digest !== "string") throw new Error("Send the transaction digest.");
    const approvalId = typeof body.approvalId === "string" ? body.approvalId : null;
    const note = typeof body.note === "string" && NOTE.test(body.note) ? body.note : null;
    return Response.json(await sendOwnerApprovedPayment(account, body.digest, approvalId, note));
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
