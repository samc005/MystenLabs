import { accountErrorResponse, requireAccount } from "@/lib/server/account-context";
import { rejectNonLocal } from "@/lib/server/local-only";
import { readVaultPolicy, type PolicyReader } from "@/lib/owner-tx";
import { createSuiClient, getSuiBalance } from "@/lib/sui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where this account's SUI is: wallet, vault, staked from the vault, and set aside for swaps. Read from chain. */
export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const account = await requireAccount(request);
    const client = createSuiClient();
    const [wallet, policy] = await Promise.all([
      getSuiBalance(client, account.ownerAddress),
      readVaultPolicy(client as unknown as PolicyReader, account.vaultId),
    ]);
    return Response.json({
      walletMist: wallet.toString(),
      vaultMist: (policy.balanceMist ?? 0n).toString(),
      stakedMist: (policy.stake?.stakedMist ?? 0n).toString(),
      stakes: Number(policy.stake?.positions ?? 0n),
      maxStakedMist: policy.stake ? policy.stake.maxStakedMist.toString() : null,
      tradingMist: (policy.tradingSuiMist ?? 0n).toString(),
      stakingOn: policy.agent?.staking === true,
      tradingOn: policy.agent?.trading === true,
    });
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: "Could not read your balances." }, { status: 502 });
  }
}
