import { rejectNonLocal } from "@/lib/server/local-only";
import { listCredentials, removeCredential } from "@/lib/server/passkey";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const rejected = rejectNonLocal(request); if (rejected) return rejected;
  try {
    const { action, id, approvalId } = await request.json();
    if (typeof approvalId !== "string") throw new Error("Passkey approval required.");
    if (action === "list") return Response.json({ credentials: await listCredentials(approvalId) });
    if (action === "remove" && typeof id === "string") {
      await removeCredential(id, approvalId); return Response.json({ ok: true });
    }
    throw new Error("Unsupported credential action.");
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Request refused." }, { status: 403 }); }
}
