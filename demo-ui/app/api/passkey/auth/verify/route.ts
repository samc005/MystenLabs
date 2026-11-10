import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { rejectNonLocal } from "@/lib/server/local-only";
import { verifyAuthentication } from "@/lib/server/passkey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const body = (await request.json()) as { challengeId?: string; response?: AuthenticationResponseJSON };
    if (!body.challengeId || !body.response) throw new Error("challengeId and response are required.");
    return Response.json(await verifyAuthentication(request, body.challengeId, body.response));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
