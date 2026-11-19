import { accountErrorResponse, requireAccount } from "@/lib/server/account-context";
import { rejectNonLocal } from "@/lib/server/local-only";
import { listProposals } from "@/lib/server/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const account = await requireAccount(request);
    return Response.json({ proposals: await listProposals(account.proposalsDir) });
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: "Could not load proposals." }, { status: 500 });
  }
}
