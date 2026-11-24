import { rejectNonLocal } from "@/lib/server/local-only";
import { enokiConfigured } from "@/lib/server/enoki";
import { userFromRequest } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who is signed in, for the UI. Returns null when nobody is. */
export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  const user = userFromRequest(request);
  return Response.json({
    user: user ? { email: user.email, name: user.name ?? null, zkAddress: user.zkAddress ?? null } : null,
    zkLoginAvailable: enokiConfigured(),
  });
}
