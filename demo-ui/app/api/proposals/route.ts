import { rejectNonLocal } from "@/lib/server/local-only";
import { listProposals } from "@/lib/server/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  return Response.json({ proposals: await listProposals() });
}
