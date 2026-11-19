import { createPendingAccount, getAccountByOwner, requireOwnerAddress } from "@/lib/server/accounts";
import { rejectNonLocal } from "@/lib/server/local-only";
import { provisionAgentAddress } from "@/lib/server/signer-provision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The vault package every new account's vault must come from. Set once by whoever runs the app. */
function vaultPackageId(): string {
  const id = process.env.SUI_VAULT_PACKAGE_ID;
  if (!id) throw new Error("Set SUI_VAULT_PACKAGE_ID to the published vault package new accounts should use.");
  return id;
}

function failure(error: unknown, status = 400) {
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const owner = requireOwnerAddress(new URL(request.url).searchParams.get("owner"));
    return Response.json({ account: (await getAccountByOwner(owner)) ?? null, packageId: vaultPackageId() });
  } catch (error) {
    return failure(error);
  }
}

/** Step 1 of onboarding: mint this owner's agent key (once) and record a pending account. */
export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const body = (await request.json().catch(() => ({}))) as { ownerAddress?: unknown };
    const packageId = vaultPackageId();
    const account = await createPendingAccount(requireOwnerAddress(body.ownerAddress), provisionAgentAddress);
    return Response.json({ account, packageId });
  } catch (error) {
    return failure(error, 502);
  }
}
