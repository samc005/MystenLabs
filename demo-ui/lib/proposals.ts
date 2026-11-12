// Shape of a proposal as stored by wallet-mcp (wallet-mcp/.proposals/*.json): a swap, or a
// payment that needs the owner's approval. Shared by the API routes and the approval card.
// No Node imports, so it is safe in the browser.

export type ProposalStatus = "pending" | "approved" | "rejected" | "expired" | "executed" | "failed";

interface ProposalBase {
  id: string;
  status: ProposalStatus;
  createdAtMs: number;
  approvalDeadlineMs: number;
  intentTtlMs: number;
  intentId?: string;
  intentExpiryMs?: number;
  approvalDigest?: string;
  error?: string;
}

export interface SwapProposal extends ProposalBase {
  kind?: "swap";
  /** Covered by a standing trade rule: no approval step. */
  auto?: boolean;
  ruleNote?: string;
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
  swapDigest?: string;
  amountOut?: string;
}

export interface SpendProposal extends ProposalBase {
  kind: "spend";
  recipient: string;
  /** Raw MIST, as a decimal string. */
  amountMist: string;
  /** Why this needed approval instead of being paid directly. */
  reason: string;
  spendDigest?: string;
}

export type Proposal = SwapProposal | SpendProposal;

export function isSpendProposal(p: Proposal): p is SpendProposal {
  return p.kind === "spend";
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
