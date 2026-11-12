import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { rejectNonLocal } from "@/lib/server/local-only";
import { verifyRegistration } from "@/lib/server/passkey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const body = (await request.json()) as { challengeId?: string; response?: RegistrationResponseJSON };
    if (!body.challengeId || !body.response) throw new Error("challengeId and response are required.");
    await verifyRegistration(request, body.challengeId, body.response);
    return Response.json({ registered: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
