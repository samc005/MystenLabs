import { accountErrorResponse, requireAccount } from "@/lib/server/account-context";
import { NOTE } from "@/lib/server/account-store";
import { rejectNonLocal } from "@/lib/server/local-only";
import { sendAfterTopUp } from "@/lib/server/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sends a payment right after the owner topped up the vault. The passkey approval must match the
 * recipient and amount, and the payment is an ordinary vault payment, so the contract enforces
 * trusted recipients and limits as for any other payment.
 */
export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const account = await requireAccount(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : null);
    const digest = text("digest");
    const recipient = text("recipient");
    const amountMist = text("amountMist");
    if (!digest || !recipient || !amountMist) throw new Error("Send the top-up digest, recipient and amount.");
    const note = text("note");
    return Response.json(
      await sendAfterTopUp(account, { digest, approvalId: text("approvalId"), recipient, amountMist, note: note && NOTE.test(note) ? note : null }),
    );
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
