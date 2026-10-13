export interface TokenBalance {
  coinType: string;
  symbol: string;
  decimals: number;
  /** Raw on-chain amount in the coin's smallest unit (MIST for SUI). */
  raw: bigint;
  /** Human-readable amount, e.g. "1.5". */
  formatted: string;
}

export interface BalanceChangeSummary {
  address: string;
  coinType: string;
  /** Signed raw amount. Negative means the address lost coins. */
  amount: string;
}

export interface TransferReceipt {
  digest: string;
  sender: string;
  recipient: string;
  amountMist: bigint;
  /** Net gas in MIST (computation + storage - rebate). Null if effects were not returned. */
  gasMist: bigint | null;
  explorerUrl: string;
  balanceChanges: BalanceChangeSummary[];
}
