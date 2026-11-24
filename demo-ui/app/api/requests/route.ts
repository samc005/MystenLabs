import { accountErrorResponse, requireAccount } from "@/lib/server/account-context";
import { cancelRequest, labelsFor, read, settleRequests } from "@/lib/server/account-store";
import { recentActivity } from "@/lib/server/activity";
import { rejectNonLocal } from "@/lib/server/local-only";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** This account's payment requests, with open ones checked against incoming payments on-chain. */
export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const account = await requireAccount(request);
    let requests = await read(account.accountId, "requests");
    if (requests.some((r) => r.status === "open")) {
      const activity = await recentActivity(account, { labels: await labelsFor(account.accountId), limit: 50 }).catch(() => []);
      const incoming = activity
        .filter((entry) => entry.kind === "received" && entry.success && entry.amountMist && entry.timestamp)
        .map((entry) => ({ digest: entry.digest, amountMist: entry.amountMist!, timestamp: entry.timestamp! }));
      requests = await settleRequests(account.accountId, incoming);
    }
    return Response.json({ requests: [...requests].reverse() });
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: "Could not load payment requests." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const account = await requireAccount(request);
    await cancelRequest(account.accountId, new URL(request.url).searchParams.get("id") ?? "");
    return Response.json({ ok: true });
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: "Could not cancel the request." }, { status: 500 });
  }
}
