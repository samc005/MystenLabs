import { accountErrorResponse, requireAccount } from "@/lib/server/account-context";
import { labelsFor, notesFor } from "@/lib/server/account-store";
import { recentActivity } from "@/lib/server/activity";
import { computeInsights, type Period } from "@/lib/server/insights";
import { rejectNonLocal } from "@/lib/server/local-only";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PERIODS = new Set<Period>(["this_week", "this_month", "all_time"]);

/** Spending insights for the signed-in account, from its on-chain history. */
export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const account = await requireAccount(request);
    const asked = new URL(request.url).searchParams.get("period") as Period | null;
    const period: Period = asked && PERIODS.has(asked) ? asked : "this_week";
    const [labels, notes] = await Promise.all([labelsFor(account.accountId), notesFor(account.accountId)]);
    const entries = await recentActivity(account, { labels, notes, pages: 4, limit: 400 });
    return Response.json({ insights: computeInsights(entries, period) });
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: "Could not compute insights." }, { status: 502 });
  }
}
