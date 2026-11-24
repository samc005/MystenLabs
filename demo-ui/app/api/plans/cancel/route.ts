import { accountErrorResponse, requireAccount } from "@/lib/server/account-context";
import { rejectNonLocal } from "@/lib/server/local-only";
import { recordCancellation } from "@/lib/server/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Marks a plan's remaining payments cancelled once the owner's cancel transaction is on-chain. */
export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const account = await requireAccount(request);
    const body = (await request.json().catch(() => ({}))) as { digest?: unknown; planId?: unknown };
    if (typeof body.digest !== "string" || typeof body.planId !== "string") throw new Error("Send the plan and the digest.");
    return Response.json({ plan: await recordCancellation(account, body.planId, body.digest) });
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
