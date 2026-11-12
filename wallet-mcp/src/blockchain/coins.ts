import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { SUI_DECIMALS, SUI_TYPE_ARG, normalizeStructTag } from "@mysten/sui/utils";
import { tradingConfig } from "../config.js";
import { formatUnits } from "./balance.js";

export interface CoinInfo {
  coinType: string;
  symbol: string;
  decimals: number;
}

const SUI_INFO: CoinInfo = { coinType: SUI_TYPE_ARG, symbol: "SUI", decimals: SUI_DECIMALS };

const cache = new Map<string, CoinInfo>();

export function isSui(coinType: string): boolean {
  return normalizeStructTag(coinType) === normalizeStructTag(SUI_TYPE_ARG);
}

/** Accepts "SUI", "tUSDC" / "USDC" / "TEST_USDC" (the testnet pool's coin), or a full coin type. */
export function resolveCoinType(input: string): string {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "sui") return SUI_TYPE_ARG;
  if (lower === "tusdc" || lower === "usdc" || lower === "test_usdc" || lower === "test usdc") {
    return tradingConfig().usdcType;
  }
  if (/^0x[0-9a-fA-F]+::\w+::\w+$/.test(trimmed)) return normalizeStructTag(trimmed);
  throw new Error(`Unknown coin "${input}". Use SUI, tUSDC, or a full coin type like 0x...::module::NAME.`);
}

export async function getCoinInfo(client: SuiGrpcClient, coinType: string): Promise<CoinInfo> {
  if (isSui(coinType)) return SUI_INFO;
  const key = normalizeStructTag(coinType);
  const cached = cache.get(key);
  if (cached) return cached;
  const { coinMetadata } = await client.getCoinMetadata({ coinType: key });
  const info: CoinInfo = {
    coinType: key,
    symbol: coinMetadata?.symbol ?? key.split("::").pop() ?? key,
    decimals: coinMetadata?.decimals ?? 0,
  };
  cache.set(key, info);
  return info;
}

/** Parses a decimal string such as "1.25" into the coin's smallest unit without float loss. */
export function parseUnits(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Amount must be a positive decimal string such as "1.5". Got "${amount}".`);
  }
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Amount "${amount}" has more than ${decimals} decimal places.`);
  }
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

export function formatAmount(raw: bigint, info: Pick<CoinInfo, "decimals" | "symbol">): string {
  return `${formatUnits(raw, info.decimals)} ${info.symbol}`;
}
