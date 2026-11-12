import { rejectNonLocal } from "@/lib/server/local-only";
import { recoverCredentials } from "@/lib/server/passkey";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const rejected = rejectNonLocal(request); if (rejected) return rejected;
  try {
    const { code } = await request.json();
    if (typeof code !== "string") throw new Error("Local recovery code required.");
    const recoveryToken = await recoverCredentials(code.trim());
    return Response.json({ ok: true, recoveryToken });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Recovery refused." }, { status: 403 }); }
}
