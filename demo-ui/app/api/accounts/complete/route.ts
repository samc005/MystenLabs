import { activateAccount, getAccount } from "@/lib/server/accounts";
import { AccountVerificationError, verifyAccountVault } from "@/lib/server/account-verify";
import { rejectNonLocal } from "@/lib/server/local-only";
import { createSuiClient } from "@/lib/sui";
import type { ChainReader } from "@/lib/owner-tx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OBJECT_ID = /^0x[0-9a-f]{64}$/;

/**
 * Last step of onboarding. The browser says which vault it created; the server checks the chain
 * and only then marks the account active. The package comes from server config, never the request.
 */
export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  const body = (await request.json().catch(() => ({}))) as {
    accountId?: unknown;
    vaultId?: unknown;
    ownerCapId?: unknown;
  };
  const { accountId, vaultId, ownerCapId } = body;
  if (
    typeof accountId !== "string" ||
    typeof vaultId !== "string" ||
    typeof ownerCapId !== "string" ||
    !OBJECT_ID.test(vaultId) ||
    !OBJECT_ID.test(ownerCapId)
  ) {
    return Response.json({ error: "Send accountId, vaultId and ownerCapId." }, { status: 400 });
  }
  const packageId = process.env.SUI_VAULT_PACKAGE_ID;
  if (!packageId) return Response.json({ error: "SUI_VAULT_PACKAGE_ID is not configured." }, { status: 500 });

  try {
    const account = await getAccount(accountId);
    if (!account) return Response.json({ error: "Unknown account." }, { status: 404 });
    const vault = await verifyAccountVault(createSuiClient() as unknown as ChainReader, {
      packageId,
      account,
      claim: { vaultId, ownerCapId },
    });
    return Response.json({ account: await activateAccount(account.id, vault) });
  } catch (error) {
    const status = error instanceof AccountVerificationError ? 422 : 502;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
