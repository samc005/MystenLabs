// Shape of a trade proposal as stored by wallet-mcp (wallet-mcp/.proposals/*.json).
// Shared by the API routes and the approval card. No Node imports, so it is safe in the browser.

export type ProposalStatus = "pending" | "approved" | "rejected" | "expired" | "executed" | "failed";

export interface Proposal {
  id: string;
  status: ProposalStatus;
  createdAtMs: number;
  approvalDeadlineMs: number;
  dex: string;
  inType: string;
  outType: string;
  inSymbol: string;
  outSymbol: string;
  inDecimals: number;
  outDecimals: number;
  /** Raw integers in each coin's smallest unit, as decimal strings. */
  amountIn: string;
  quotedOut: string;
  minOut: string;
  slippageBps: number;
  intentTtlMs: number;
  intentId?: string;
  intentExpiryMs?: number;
  approvalDigest?: string;
  swapDigest?: string;
  amountOut?: string;
  error?: string;
}

export const PROPOSAL_ID = /^prop_[0-9a-f]{10}$/;

/** "50000000" with 9 decimals -> "0.05". */
export function formatUnits(raw: string, decimals: number): string {
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${value / base}${fraction ? `.${fraction}` : ""}`;
}

export function explorerTx(digest: string): string {
  return `https://suiscan.xyz/testnet/tx/${digest}`;
}
