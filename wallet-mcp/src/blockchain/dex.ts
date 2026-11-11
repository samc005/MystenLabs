import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Transaction, TransactionObjectArgument } from "@mysten/sui/transactions";
import { tradingConfig } from "../config.js";
import { isSui, resolveCoinType } from "./coins.js";
import { normalizeStructTag } from "@mysten/sui/utils";

/**
 * A venue the agent can route a swap through. The vault does not care which one: its
 * contract only checks the coins that went in and the coins that came out against the
 * owner's approved `min_out`. Add a real DEX by implementing this interface.
 */
export interface Dex {
  name: string;
  /** Expected output for selling `amountIn` of `inType` for `outType`. Throws if unroutable. */
  quote(client: SuiGrpcClient, inType: string, outType: string, amountIn: bigint): Promise<bigint>;
  /** Appends the swap to `tx` and returns the coin it produces. */
  addSwap(tx: Transaction, coinIn: TransactionObjectArgument, inType: string, outType: string): TransactionObjectArgument;
}

const MIST_PER_SUI = 1_000_000_000n;
const BPS = 10_000n;

type PairDirection = "sui-to-usdc" | "usdc-to-sui";

function direction(inType: string, outType: string): PairDirection {
  const usdc = normalizeStructTag(resolveCoinType("usdc"));
  if (isSui(inType) && normalizeStructTag(outType) === usdc) return "sui-to-usdc";
  if (normalizeStructTag(inType) === usdc && isSui(outType)) return "usdc-to-sui";
  throw new Error(`The testnet pool only trades SUI <-> tUSDC, not ${inType} -> ${outType}.`);
}

function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return BigInt(value);
  if (typeof value === "object" && value !== null && "value" in value) {
    return toBigInt((value as { value: unknown }).value, field);
  }
  throw new Error(`Unexpected pool field "${field}": ${JSON.stringify(value)}`);
}

export interface PoolState {
  /** Micro-tUSDC per 1 SUI. */
  price: bigint;
  feeBps: bigint;
  suiReserveMist: bigint;
}

export async function getPoolState(client: SuiGrpcClient): Promise<PoolState> {
  const { poolId } = tradingConfig();
  const { object } = await client.getObject({ objectId: poolId, include: { json: true } });
  const fields = object.json;
  if (!fields) throw new Error(`Pool ${poolId} has no readable content.`);
  return {
    price: toBigInt(fields.price, "price"),
    feeBps: toBigInt(fields.fee_bps, "fee_bps"),
    suiReserveMist: toBigInt(fields.sui_reserve, "sui_reserve"),
  };
}

/** Mirrors testnet_pool::test_usdc::quote_* exactly (integer math, rounds down). */
export function quoteFromState(state: PoolState, dir: PairDirection, amountIn: bigint): bigint {
  return dir === "sui-to-usdc"
    ? (amountIn * state.price * (BPS - state.feeBps)) / (MIST_PER_SUI * BPS)
    : (amountIn * MIST_PER_SUI * (BPS - state.feeBps)) / (state.price * BPS);
}

/** The testnet mock pool (testnet_pool::test_usdc): fixed owner-set price plus a fee. */
export const mockPoolDex: Dex = {
  name: "testnet mock pool",

  async quote(client, inType, outType, amountIn) {
    const dir = direction(inType, outType);
    const state = await getPoolState(client);
    const out = quoteFromState(state, dir, amountIn);
    if (out <= 0n) throw new Error("That amount is too small to swap: it would return nothing.");
    if (dir === "usdc-to-sui" && out > state.suiReserveMist) {
      throw new Error("The pool does not hold enough SUI to buy that much tUSDC.");
    }
    return out;
  },

  addSwap(tx, coinIn, inType, outType) {
    const dir = direction(inType, outType);
    const { poolPackageId, poolId } = tradingConfig();
    const [coinOut] = tx.moveCall({
      target: `${poolPackageId}::test_usdc::${dir === "sui-to-usdc" ? "swap_sui_for_usdc" : "swap_usdc_for_sui"}`,
      arguments: [tx.object(poolId), coinIn],
    });
    return coinOut!;
  },
};

export function getDex(): Dex {
  return mockPoolDex;
}
