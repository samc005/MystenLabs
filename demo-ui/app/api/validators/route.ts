import { accountErrorResponse, requireAccount } from "@/lib/server/account-context";
import { rejectNonLocal } from "@/lib/server/local-only";
import { listValidators } from "@/lib/server/validators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Active testnet validators, largest first. */
export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    await requireAccount(request);
    return Response.json({ validators: await listValidators() });
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: (error as Error).message }, { status: 502 });
  }
}
