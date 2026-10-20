import { rejectNonLocal } from "@/lib/server/local-only";
import { listLocalWallets, walletMcpStatus } from "@/lib/server/wallet-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  const [wallets, status] = await Promise.all([listLocalWallets(), walletMcpStatus()]);
  return Response.json({ wallets, status });
}
