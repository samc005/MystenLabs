import { registrationOptions } from "@/lib/server/passkey";
import { rejectNonLocal } from "@/lib/server/local-only";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const body = (await request.json()) as { approvalId?: string; recoveryToken?: string };
    return Response.json(await registrationOptions(request, body.approvalId, body.recoveryToken));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
