import { rejectNonLocal } from "@/lib/server/local-only";
import { consumeApproval, setRevoked } from "@/lib/server/passkey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const body = (await request.json()) as { approvalId?: string; proposalHash?: string; revoked?: boolean };
    if (!body.approvalId || !body.proposalHash || typeof body.revoked !== "boolean") {
      throw new Error("approvalId, proposalHash, and revoked are required.");
    }
    await consumeApproval(body.approvalId, body.proposalHash);
    await setRevoked(body.revoked);
    return Response.json({ revoked: body.revoked });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
