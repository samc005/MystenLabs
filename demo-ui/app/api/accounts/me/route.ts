import { type Account, getAccountByUser, updateDisplayName } from "@/lib/server/accounts";
import { rejectNonLocal } from "@/lib/server/local-only";
import { userFromRequest } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicAccount(account: Account) {
  return {
    id: account.id,
    status: account.status,
    ownerAddress: account.ownerAddress,
    agentAddress: account.agentAddress,
    vault: account.vault ?? null,
    displayName: account.displayName ?? null,
  };
}

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
      account: account ? publicAccount(account) : null,
    });
  } catch {
    return Response.json({ error: "Could not load your account." }, { status: 500 });
  }
}

/** Changes the profile name of the signed-in user's account. */
export async function PATCH(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  const user = userFromRequest(request);
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { displayName?: unknown } | null;
  try {
    const account = await updateDisplayName(user.sub, body?.displayName);
    return Response.json({ account: publicAccount(account) });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
