import { registrationOptions } from "@/lib/server/passkey";
import { rejectNonLocal } from "@/lib/server/local-only";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    return Response.json(await registrationOptions(request));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
