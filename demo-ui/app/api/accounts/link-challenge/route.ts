import { requireOwnerAddress } from "@/lib/server/accounts";
import { rejectNonLocal } from "@/lib/server/local-only";
import { issueLinkChallenge } from "@/lib/server/owner-proof";
import { userFromRequest } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A one-time message for the user's wallet to sign, proving it controls the address it links. */
export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  const user = userFromRequest(request);
  if (!user) return Response.json({ error: "Sign in with Google first." }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { address?: unknown };
    return Response.json(issueLinkChallenge(user, requireOwnerAddress(body.address)));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
