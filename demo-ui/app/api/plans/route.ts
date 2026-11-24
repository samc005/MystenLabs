import { accountErrorResponse, requireAccount } from "@/lib/server/account-context";
import { read } from "@/lib/server/account-store";
import { rejectNonLocal } from "@/lib/server/local-only";
import { registerPlan } from "@/lib/server/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** This account's payment plans. */
export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const account = await requireAccount(request);
    return Response.json({ plans: [...(await read(account.accountId, "plans"))].reverse() });
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: "Could not load plans." }, { status: 500 });
  }
}

/** Records a plan after the owner signed it. Only the digest is trusted; terms are read from chain. */
export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const account = await requireAccount(request);
    const body = (await request.json().catch(() => ({}))) as { digest?: unknown; note?: unknown };
    if (typeof body.digest !== "string") throw new Error("Send the plan transaction digest.");
    const plan = await registerPlan(account, body.digest, typeof body.note === "string" ? body.note : null);
    return Response.json({ plan });
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
