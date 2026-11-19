import { accountErrorResponse, requireAccount } from "@/lib/server/account-context";
import { rejectNonLocal } from "@/lib/server/local-only";
import { listAccountWallets, walletMcpStatus } from "@/lib/server/wallet-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const account = await requireAccount(request);
    const [wallets, status] = await Promise.all([listAccountWallets(account), walletMcpStatus()]);
    return Response.json({ wallets, status });
  } catch (error) {
    return accountErrorResponse(error) ?? Response.json({ error: "Could not load your wallets." }, { status: 500 });
  }
}
