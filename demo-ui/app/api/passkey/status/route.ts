import { rejectNonLocal } from "@/lib/server/local-only";
import { passkeyStatus } from "@/lib/server/passkey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  return Response.json(await passkeyStatus());
}
