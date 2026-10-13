import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { SUI_TYPE_ARG, normalizeStructTag } from "@mysten/sui/utils";

export interface TokenBalance {
  coinType: string;
  symbol: string;
  decimals: number;
  /** Raw on-chain amount in the coin's smallest unit (e.g. MIST for SUI). */
  raw: bigint;
  /** Human-readable amount, e.g. "1.5". */
  formatted: string;
}

/** Converts a raw integer amount into a decimal string without floating-point loss. */
export function formatUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

async function describeBalance(
  client: SuiGrpcClient,
  coinType: string,
  raw: bigint,
): Promise<TokenBalance> {
  const { coinMetadata } = await client.getCoinMetadata({ coinType });
  const decimals = coinMetadata?.decimals ?? 0;
  const symbol = coinMetadata?.symbol ?? coinType.split("::").pop() ?? coinType;
  return { coinType, symbol, decimals, raw, formatted: formatUnits(raw, decimals) };
}

export async function getBalance(
  client: SuiGrpcClient,
  owner: string,
  coinType: string = SUI_TYPE_ARG,
): Promise<TokenBalance> {
  const { balance } = await client.getBalance({ owner, coinType });
  return describeBalance(client, coinType, BigInt(balance.balance));
}

/** Every coin type the address holds, SUI first, then by symbol. */
export async function getAllBalances(
  client: SuiGrpcClient,
  owner: string,
): Promise<TokenBalance[]> {
  const entries: { coinType: string; balance: string }[] = [];
  let page = await client.listBalances({ owner, limit: 50 });
  while (true) {
    entries.push(...page.balances);
    if (!page.hasNextPage) break;
    page = await client.listBalances({ owner, limit: 50, cursor: page.cursor });
  }

  const balances = await Promise.all(
    entries.map((b) => describeBalance(client, b.coinType, BigInt(b.balance))),
  );

  const sui = normalizeStructTag(SUI_TYPE_ARG);
  return balances.sort((a, b) => {
    const aIsSui = normalizeStructTag(a.coinType) === sui;
    const bIsSui = normalizeStructTag(b.coinType) === sui;
    if (aIsSui !== bIsSui) return aIsSui ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });
}
