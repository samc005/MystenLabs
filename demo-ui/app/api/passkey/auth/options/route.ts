import { rejectNonLocal } from "@/lib/server/local-only";
import { authenticationOptions } from "@/lib/server/passkey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const body = (await request.json()) as { proposalHash?: string };
    if (!body.proposalHash) throw new Error("proposalHash is required.");
    return Response.json(await authenticationOptions(request, body.proposalHash));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
