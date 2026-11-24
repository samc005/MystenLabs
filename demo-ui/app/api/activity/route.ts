import { accountErrorResponse, requireAccount } from "@/lib/server/account-context";
import { contactLabels, recentActivity } from "@/lib/server/activity";
import { rejectNonLocal } from "@/lib/server/local-only";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in account's recent transactions, read from the chain. Only that account's addresses. */
export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const account = await requireAccount(request);
    const entries = await recentActivity(account, { labels: contactLabels() });
    return Response.json({ entries });
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: "Could not load recent transactions." }, { status: 502 });
  }
}
