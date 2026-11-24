import { rejectNonLocal } from "@/lib/server/local-only";
import { userFromRequest } from "@/lib/server/session";
import { loadZkLoginSession } from "@/lib/server/zklogin-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The zkLogin proof for this browser's ephemeral key, if the signed-in user created one at sign-in.
 * The proof cannot sign without the ephemeral private key, which only that browser holds.
 */
export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  const user = userFromRequest(request);
  if (!user) return Response.json({ error: "Sign in with Google first." }, { status: 401 });
  const publicKey = new URL(request.url).searchParams.get("publicKey") ?? "";
  const session = await loadZkLoginSession(user.sub, publicKey);
  if (!session || session.address !== user.zkAddress) {
    return Response.json({ error: "Your wallet session expired. Sign in again to sign with your wallet.", code: "zk_expired" }, { status: 404 });
  }
  return Response.json({ address: session.address, maxEpoch: session.maxEpoch, proof: session.proof, expiresAt: session.expiresAt });
}
