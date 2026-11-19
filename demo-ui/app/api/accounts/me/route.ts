import { getAccountByUser } from "@/lib/server/accounts";
import { rejectNonLocal } from "@/lib/server/local-only";
import { userFromRequest } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who is signed in and how far their account is, so the home page can route them. */
export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  const user = userFromRequest(request);
  if (!user) return Response.json({ user: null, account: null });
  try {
    const account = await getAccountByUser(user.sub);
    return Response.json({
      user: { email: user.email, name: user.name ?? null },
      account: account
        ? {
            id: account.id,
            status: account.status,
            ownerAddress: account.ownerAddress,
            agentAddress: account.agentAddress,
            vault: account.vault ?? null,
          }
        : null,
    });
  } catch {
    return Response.json({ error: "Could not load your account." }, { status: 500 });
  }
}
