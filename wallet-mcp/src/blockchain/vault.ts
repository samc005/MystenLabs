import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  SUI_DECIMALS,
  SUI_SYSTEM_STATE_OBJECT_ID,
  toHex,
} from "@mysten/sui/utils";
import { assertTestnet, explorerTxUrl, knownCoin, vaultConfig, type VaultConfig } from "../config.js";
import { formatUnits } from "./balance.js";
import type { SuiNetwork } from "./client.js";
import { formatAmount, getCoinInfo } from "./coins.js";
import { netGasMist } from "./transfer.js";
import type { TransferReceipt } from "./types.js";
import { requireAddress } from "./address.js";

/** Sui rejects stakes below 1 SUI (staking_pool::MIN_STAKING_THRESHOLD). */
export const MIN_STAKE_MIST = 1_000_000_000n;

/** A StakedSui receipt held inside the vault. Only the owner can unstake it. */
export interface StakePosition {
  stakedSuiId: string;
  principalMist: bigint;
  activationEpoch: string;
}

/** A non-SUI coin balance held by the vault. Only the owner can withdraw it. */
export interface HeldCoin {
  coinType: string;
  raw: bigint;
}

/** Coins in the vault's trading sleeve: the only funds the agent can swap. */
export interface TradingBalance {
  coinType: string;
  symbol: string;
  decimals: number;
  raw: bigint;
}

/** An owner-approved trade waiting for the agent to execute it. */
export interface IntentInfo {
  intentId: string;
  inType: string;
  outType: string;
  inSymbol: string;
  outSymbol: string;
  inDecimals: number;
  outDecimals: number;
  amountIn: bigint;
  minOut: bigint;
  expiryMs: number;
}

/** Owner-set rules on direct spends: a per-epoch cap and an optional recipient allowlist. */
export interface SpendPolicyInfo {
  dailyCapMist: bigint;
  enforceRecipients: boolean;
  windowEpoch: bigint;
  spentInWindowMist: bigint;
}

/** Owner-set rules on staking: size cap, liquid reserve and position limit. */
export interface StakePolicyInfo {
  maxStakedMist: bigint;
  minReserveMist: bigint;
  maxPositions: bigint;
  stakedTotalMist: bigint;
  positions: bigint;
}

/** An owner-approved one-off payment waiting for the agent to execute it. */
export interface SpendIntentInfo {
  intentId: string;
  recipient: string;
  amountMist: bigint;
  expiryMs: number;
}

/** A standing permission to swap one pair within limits and above a price floor. */
export interface TradeRuleInfo {
  inType: string;
  outType: string;
  inSymbol: string;
  outSymbol: string;
  inDecimals: number;
  outDecimals: number;
  maxPerTrade: bigint;
  maxPerEpoch: bigint;
  /** The agent must receive at least amountIn * rateNum / rateDen (rounded up) in raw units. */
  rateNum: bigint;
  rateDen: bigint;
  expiryMs: number;
  windowEpoch: bigint;
  spentInWindow: bigint;
}

/** Current on-chain state of the spending vault. */
export interface VaultStatus {
  vaultId: string;
  balanceMist: bigint;
  perTxLimitMist: bigint;
  totalSpentMist: bigint;
  paused: boolean;
  /** Validators the owner has allowed the agent to stake with. */
  allowedValidators: string[];
  /** Open staking positions held by the vault. */
  stakes: StakePosition[];
  /** Coin types (other than SUI) the owner allows the vault to hold. */
  allowedCoins: string[];
  /** Non-SUI coin balances in the vault. */
  coins: HeldCoin[];
  /** Per-coin balances the owner has allocated for the agent to swap. */
  trading: TradingBalance[];
  /** Owner-approved trades the agent may still execute. */
  intents: IntentInfo[];
  /** The network's current epoch; per-epoch counters reset when it changes. */
  currentEpoch: bigint;
  spendPolicy: SpendPolicyInfo | null;
  /** Addresses the agent may pay directly when the spend policy enforces recipients. */
  allowedRecipients: string[];
  stakePolicy: StakePolicyInfo | null;
  /** Owner-approved one-off payments the agent may still execute. */
  spendIntents: SpendIntentInfo[];
  /** Standing trade rules, one per coin pair. */
  tradeRules: TradeRuleInfo[];
}

/** Move serializes u64 as a string and Balance<T> as either a string or { value }. */
function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return BigInt(value);
  }
  if (typeof value === "object" && value !== null && "value" in value) {
    return toBigInt((value as { value: unknown }).value, field);
  }
  throw new Error(`Unexpected vault field "${field}": ${JSON.stringify(value)}`);
}

export async function getVaultStatus(
  client: SuiGrpcClient,
  config: VaultConfig = vaultConfig(),
): Promise<VaultStatus> {
  const { object } = await client.getObject({
    objectId: config.vaultId,
    include: { json: true },
  });
  const fields = object.json;
  if (!fields) throw new Error(`Vault ${config.vaultId} has no readable content.`);
  const [dynamic, system] = await Promise.all([
    readVaultDynamicFields(client, config.vaultId),
    client.getCurrentSystemState(),
  ]);
  return {
    vaultId: config.vaultId,
    balanceMist: toBigInt(fields.balance, "balance"),
    perTxLimitMist: toBigInt(fields.per_tx_limit, "per_tx_limit"),
    totalSpentMist: toBigInt(fields.total_spent, "total_spent"),
    paused: fields.paused === true,
    currentEpoch: BigInt(system.systemState.epoch),
    ...dynamic,
  };
}

/** Top-level generic arguments of a Move type: `A::m::S<X, B::m::T<Y>>` -> [X, B::m::T<Y>]. */
export function typeArguments(type: string): string[] {
  const start = type.indexOf("<");
  const end = type.lastIndexOf(">");
  if (start < 0 || end < start) return [];
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of type.slice(start + 1, end)) {
    if (char === "<") depth += 1;
    if (char === ">") depth -= 1;
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) args.push(current.trim());
  return args.map((arg) => normalizeStructTag(arg));
}

/** `0x..::spending_vault::CoinKey<0x..::dbtc::DBTC>` -> `0x..::dbtc::DBTC`. */
function coinTypeArgument(keyType: string): string {
  const start = keyType.indexOf("<");
  const end = keyType.lastIndexOf(">");
  if (start === -1 || end <= start) throw new Error(`Unexpected vault coin key type: ${keyType}`);
  return normalizeStructTag(keyType.slice(start + 1, end));
}

/**
 * The allowlist and staking receipts live on the vault as dynamic fields (keeps the
 * Vault struct unchanged across upgrades). Keys are identified by their Move type name.
 */
async function readVaultDynamicFields(client: SuiGrpcClient, vaultId: string) {
  const allowedValidators: string[] = [];
  const stakedSuiIds: string[] = [];
  const allowedCoins: string[] = [];
  const coins: HeldCoin[] = [];
  const tradingFields: { fieldId: string; coinType: string }[] = [];
  const intentIds: string[] = [];
  const allowedRecipients: string[] = [];
  const spendIntentIds: string[] = [];
  let spendPolicyFieldId: string | null = null;
  let stakePolicyFieldId: string | null = null;
  const ruleFields: { fieldId: string; inType: string; outType: string }[] = [];

  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<typeof client.listDynamicFields<{ value: true }>>> = await client.listDynamicFields({
      parentId: vaultId,
      cursor,
      include: { value: true },
    });
    for (const entry of page.dynamicFields) {
      if (entry.name.type.includes("::spending_vault::AllowedValidator")) {
        // struct AllowedValidator { validator: address } serializes to the 32 address bytes.
        allowedValidators.push(normalizeSuiAddress(`0x${toHex(entry.name.bcs)}`));
      } else if (entry.$kind === "DynamicObject" && entry.name.type.includes("::spending_vault::StakeKey")) {
        stakedSuiIds.push(entry.childId);
      } else if (entry.name.type.includes("::spending_vault::AllowedCoin<")) {
        allowedCoins.push(coinTypeArgument(entry.name.type));
      } else if (entry.name.type.includes("::spending_vault::CoinKey<")) {
        // Balance<T> { value: u64 } serializes to a single u64.
        coins.push({ coinType: coinTypeArgument(entry.name.type), raw: BigInt(bcs.u64().parse(entry.value.bcs)) });
      } else if (entry.$kind === "DynamicField" && entry.name.type.includes("::spending_vault::TradingKey<")) {
        const [coinType] = typeArguments(entry.name.type);
        if (coinType) tradingFields.push({ fieldId: entry.fieldId, coinType });
      } else if (entry.$kind === "DynamicObject" && entry.name.type.includes("::spending_vault::IntentKey")) {
        intentIds.push(entry.childId);
      } else if (entry.name.type.includes("::spending_vault::AllowedRecipient")) {
        allowedRecipients.push(normalizeSuiAddress(`0x${toHex(entry.name.bcs)}`));
      } else if (entry.$kind === "DynamicObject" && entry.name.type.includes("::spending_vault::SpendIntentKey")) {
        spendIntentIds.push(entry.childId);
      } else if (entry.$kind === "DynamicField" && entry.name.type.includes("::spending_vault::SpendPolicyKey")) {
        spendPolicyFieldId = entry.fieldId;
      } else if (entry.$kind === "DynamicField" && entry.name.type.includes("::spending_vault::StakePolicyKey")) {
        stakePolicyFieldId = entry.fieldId;
      } else if (entry.$kind === "DynamicField" && entry.name.type.includes("::spending_vault::TradeRuleKey<")) {
        const [inType, outType] = typeArguments(entry.name.type);
        if (inType && outType) ruleFields.push({ fieldId: entry.fieldId, inType, outType });
      }
    }
    cursor = page.hasNextPage ? page.cursor : null;
  } while (cursor);

  const stakes: StakePosition[] = [];
  if (stakedSuiIds.length > 0) {
    const { objects } = await client.getObjects({ objectIds: stakedSuiIds, include: { json: true } });
    for (const object of objects) {
      if (object instanceof Error || !object.json) continue;
      stakes.push({
        stakedSuiId: object.objectId,
        principalMist: toBigInt(object.json.principal, "principal"),
        activationEpoch: String(object.json.stake_activation_epoch),
      });
    }
  }

  const trading: TradingBalance[] = [];
  if (tradingFields.length > 0) {
    const { objects } = await client.getObjects({
      objectIds: tradingFields.map((field) => field.fieldId),
      include: { json: true },
    });
    for (const [index, object] of objects.entries()) {
      if (object instanceof Error || !object.json) continue;
      const info = await getCoinInfo(client, tradingFields[index]!.coinType);
      trading.push({ ...info, raw: toBigInt(object.json.value, "trading balance") });
    }
  }

  const intents: IntentInfo[] = [];
  if (intentIds.length > 0) {
    const { objects } = await client.getObjects({ objectIds: intentIds, include: { json: true } });
    for (const object of objects) {
      if (object instanceof Error || !object.json) continue;
      const [inType, outType] = typeArguments(object.type);
      if (!inType || !outType) continue;
      const [inInfo, outInfo] = await Promise.all([getCoinInfo(client, inType), getCoinInfo(client, outType)]);
      intents.push({
        intentId: object.objectId,
        inType,
        outType,
        inSymbol: inInfo.symbol,
        outSymbol: outInfo.symbol,
        inDecimals: inInfo.decimals,
        outDecimals: outInfo.decimals,
        amountIn: toBigInt(object.json.amount_in, "amount_in"),
        minOut: toBigInt(object.json.min_out, "min_out"),
        expiryMs: Number(toBigInt(object.json.expiry_ms, "expiry_ms")),
      });
    }
  }

  // A dynamic field's JSON is { id, name, value }; for struct values `value` holds the fields.
  const policyIds = [spendPolicyFieldId, stakePolicyFieldId].filter((id): id is string => id !== null);
  const policyObjects = new Map<string, Record<string, unknown>>();
  if (policyIds.length > 0 || spendIntentIds.length > 0 || ruleFields.length > 0) {
    const { objects } = await client.getObjects({
      objectIds: [...policyIds, ...spendIntentIds, ...ruleFields.map((r) => r.fieldId)],
      include: { json: true },
    });
    for (const object of objects) {
      if (object instanceof Error || !object.json) continue;
      policyObjects.set(object.objectId, object.json as Record<string, unknown>);
    }
  }
  const valueOf = (id: string | null): Record<string, unknown> | null => {
    if (!id) return null;
    const json = policyObjects.get(id);
    const value = json?.value;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  };

  const spendValue = valueOf(spendPolicyFieldId);
  const spendPolicy: SpendPolicyInfo | null = spendValue
    ? {
        dailyCapMist: toBigInt(spendValue.daily_cap, "daily_cap"),
        enforceRecipients: spendValue.enforce_recipients === true,
        windowEpoch: toBigInt(spendValue.window_epoch, "window_epoch"),
        spentInWindowMist: toBigInt(spendValue.spent_in_window, "spent_in_window"),
      }
    : null;

  const stakeValue = valueOf(stakePolicyFieldId);
  const stakePolicy: StakePolicyInfo | null = stakeValue
    ? {
        maxStakedMist: toBigInt(stakeValue.max_staked, "max_staked"),
        minReserveMist: toBigInt(stakeValue.min_reserve, "min_reserve"),
        maxPositions: toBigInt(stakeValue.max_positions, "max_positions"),
        stakedTotalMist: toBigInt(stakeValue.staked_total, "staked_total"),
        positions: toBigInt(stakeValue.positions, "positions"),
      }
    : null;

  const spendIntents: SpendIntentInfo[] = [];
  for (const id of spendIntentIds) {
    const json = policyObjects.get(id);
    if (!json) continue;
    spendIntents.push({
      intentId: id,
      recipient: normalizeSuiAddress(String(json.recipient)),
      amountMist: toBigInt(json.amount, "amount"),
      expiryMs: Number(toBigInt(json.expiry_ms, "expiry_ms")),
    });
  }

  const tradeRules: TradeRuleInfo[] = [];
  for (const rule of ruleFields) {
    const value = valueOf(rule.fieldId);
    if (!value) continue;
    const [inInfo, outInfo] = await Promise.all([getCoinInfo(client, rule.inType), getCoinInfo(client, rule.outType)]);
    tradeRules.push({
      inType: rule.inType,
      outType: rule.outType,
      inSymbol: inInfo.symbol,
      outSymbol: outInfo.symbol,
      inDecimals: inInfo.decimals,
      outDecimals: outInfo.decimals,
      maxPerTrade: toBigInt(value.max_per_trade, "max_per_trade"),
      maxPerEpoch: toBigInt(value.max_per_epoch, "max_per_epoch"),
      rateNum: toBigInt(value.rate_num, "rate_num"),
      rateDen: toBigInt(value.rate_den, "rate_den"),
      expiryMs: Number(toBigInt(value.expiry_ms, "expiry_ms")),
      windowEpoch: toBigInt(value.window_epoch, "window_epoch"),
      spentInWindow: toBigInt(value.spent_in_window, "spent_in_window"),
    });
  }

  return {
    allowedValidators,
    allowedCoins,
    coins,
    stakes,
    trading,
    intents,
    spendPolicy,
    allowedRecipients,
    stakePolicy,
    spendIntents,
    tradeRules,
  };
}

/** How much of the per-epoch spend cap is left, counting a stale window as empty. */
export function spendCapRemaining(status: VaultStatus): bigint | null {
  const p = status.spendPolicy;
  if (!p) return null;
  const spent = p.windowEpoch === status.currentEpoch ? p.spentInWindowMist : 0n;
  return p.dailyCapMist > spent ? p.dailyCapMist - spent : 0n;
}

/** The smallest output the rule accepts for selling `amountIn`, rounded up like the contract. */
export function ruleFloor(rule: Pick<TradeRuleInfo, "rateNum" | "rateDen">, amountIn: bigint): bigint {
  return (amountIn * rule.rateNum + rule.rateDen - 1n) / rule.rateDen;
}

export type RuleVerdict =
  | { covered: true; rule: TradeRuleInfo }
  | { covered: false; rule: TradeRuleInfo | null; reason: string };

/**
 * Whether a standing trade rule lets the agent run this swap with no owner approval.
 * Mirrors begin_swap_auto for a clear message; the contract is the boundary.
 */
export function evaluateTradeRule(
  status: VaultStatus,
  trade: { inType: string; outType: string; amountIn: bigint; minOut: bigint },
  now = Date.now(),
): RuleVerdict {
  const rule = status.tradeRules.find((r) => r.inType === trade.inType && r.outType === trade.outType) ?? null;
  if (!rule) return { covered: false, rule: null, reason: "no standing rule covers this pair" };
  const inCoin = { decimals: rule.inDecimals, symbol: rule.inSymbol };
  const outCoin = { decimals: rule.outDecimals, symbol: rule.outSymbol };
  if (now > rule.expiryMs) return { covered: false, rule, reason: "the standing rule has expired" };
  if (trade.amountIn > rule.maxPerTrade) {
    return { covered: false, rule, reason: `it is over the rule's ${formatAmount(rule.maxPerTrade, inCoin)} per-trade maximum` };
  }
  const used = rule.windowEpoch === status.currentEpoch ? rule.spentInWindow : 0n;
  if (used + trade.amountIn > rule.maxPerEpoch) {
    return {
      covered: false,
      rule,
      reason: `it would take this epoch's total past the rule's ${formatAmount(rule.maxPerEpoch, inCoin)} (${formatAmount(used, inCoin)} used)`,
    };
  }
  const floor = ruleFloor(rule, trade.amountIn);
  if (trade.minOut < floor) {
    return {
      covered: false,
      rule,
      reason: `the price is below the rule's floor (it needs at least ${formatAmount(floor, outCoin)} back)`,
    };
  }
  return { covered: true, rule };
}

/**
 * Whether the agent may pay `recipient` `amountMist` directly, or the owner must approve
 * it first. Mirrors the contract's rules for a clear message; the contract is the boundary.
 */
export function classifySpend(
  status: VaultStatus,
  recipient: string,
  amountMist: bigint,
): { direct: true } | { direct: false; reason: string } {
  const sui = (mist: bigint) => `${formatUnits(mist, SUI_DECIMALS)} SUI`;
  if (amountMist > status.perTxLimitMist) {
    return { direct: false, reason: `${sui(amountMist)} is over the per-spend limit of ${sui(status.perTxLimitMist)}` };
  }
  const policy = status.spendPolicy;
  if (!policy) return { direct: true };
  if (policy.enforceRecipients && !status.allowedRecipients.includes(normalizeSuiAddress(recipient))) {
    return { direct: false, reason: `${recipient} is not on the vault's recipient allowlist` };
  }
  const remaining = spendCapRemaining(status) ?? 0n;
  if (amountMist > remaining) {
    return { direct: false, reason: `${sui(amountMist)} is more than the ${sui(remaining)} left of this epoch's spending cap` };
  }
  return { direct: true };
}

/** Unknown coin types show the raw amount and full type rather than a guessed symbol. */
function formatCoinAmount(coinType: string, raw: bigint): string {
  const known = knownCoin(coinType);
  return known ? `${formatUnits(raw, known.decimals)} ${known.symbol}` : `${raw} (raw units of ${coinType})`;
}

function coinLabel(coinType: string): string {
  const known = knownCoin(coinType);
  return known ? `${known.symbol} (${coinType})` : coinType;
}

export function formatVaultStatus(status: VaultStatus, config: VaultConfig = vaultConfig()): string {
  const sui = (mist: bigint) => `${formatUnits(mist, SUI_DECIMALS)} SUI`;
  return [
    `Vault: ${status.vaultId}`,
    `Package: ${config.packageId}`,
    `Balance: ${sui(status.balanceMist)}`,
    `Per-spend limit: ${sui(status.perTxLimitMist)}`,
    `Total spent so far: ${sui(status.totalSpentMist)}`,
    `Status: ${status.paused ? "PAUSED (all spends and stakes will be rejected)" : "active"}`,
    `Allowed validators: ${status.allowedValidators.length ? status.allowedValidators.join(", ") : "none (staking is blocked until the owner allows one)"}`,
    status.stakes.length
      ? `Staked: ${status.stakes.map((s) => `${sui(s.principalMist)} (receipt ${s.stakedSuiId}, active from epoch ${s.activationEpoch})`).join("; ")}`
      : "Staked: nothing",
    `Other coins allowed: ${status.allowedCoins.length ? status.allowedCoins.map(coinLabel).join(", ") : "none (only SUI until the owner allows a coin)"}`,
    status.coins.length
      ? `Other coins held (owner-only withdrawal): ${status.coins.map((c) => formatCoinAmount(c.coinType, c.raw)).join("; ")}`
      : "Other coins held: none",
    status.trading.length
      ? `Trading sleeve (the only funds the agent can swap): ${status.trading.map((t) => formatAmount(t.raw, t)).join(", ")}`
      : "Trading sleeve: empty (the owner has not allocated any funds for swaps)",
    status.intents.length
      ? `Approved trades waiting to run:\n${status.intents
          .map(
            (i) =>
              `  - ${i.intentId}: sell ${formatAmount(i.amountIn, { decimals: i.inDecimals, symbol: i.inSymbol })} for at least ${formatAmount(i.minOut, { decimals: i.outDecimals, symbol: i.outSymbol })}, expires ${new Date(i.expiryMs).toISOString()}`,
          )
          .join("\n")}`
      : "Approved trades waiting to run: none",
    ...formatPolicyLines(status),
  ].join("\n");
}

function formatPolicyLines(status: VaultStatus): string[] {
  const sui = (mist: bigint) => `${formatUnits(mist, SUI_DECIMALS)} SUI`;
  const lines: string[] = [];

  const sp = status.spendPolicy;
  if (sp) {
    const remaining = spendCapRemaining(status) ?? 0n;
    lines.push(
      `Spend policy: up to ${sui(sp.dailyCapMist)} per epoch (${sui(remaining)} left this epoch), ${
        sp.enforceRecipients
          ? `only to allowed recipients: ${status.allowedRecipients.length ? status.allowedRecipients.join(", ") : "none yet"}`
          : "any recipient"
      }. Anything outside this needs the owner's approval (propose_spend).`,
    );
  } else {
    lines.push(`Spend policy: none (the agent can pay anyone, up to the per-spend limit, with no total cap)`);
  }
  lines.push(
    status.spendIntents.length
      ? `Approved payments waiting to run:\n${status.spendIntents
          .map(
            (i) =>
              `  - ${i.intentId}: pay ${sui(i.amountMist)} to ${i.recipient}, expires ${new Date(i.expiryMs).toISOString()}`,
          )
          .join("\n")}`
      : "Approved payments waiting to run: none",
  );

  const kp = status.stakePolicy;
  lines.push(
    kp
      ? `Stake policy: at most ${sui(kp.maxStakedMist)} staked (${sui(kp.stakedTotalMist)} now), keep ${sui(kp.minReserveMist)} liquid, at most ${kp.maxPositions} positions (${kp.positions} now)`
      : "Stake policy: none (the agent can stake the whole balance, in any number of positions)",
  );

  lines.push(
    status.tradeRules.length
      ? `Standing trade rules (no per-trade approval needed inside these):\n${status.tradeRules
          .map((r) => {
            const stale = r.windowEpoch !== status.currentEpoch;
            const used = stale ? 0n : r.spentInWindow;
            const inCoin = { decimals: r.inDecimals, symbol: r.inSymbol };
            const outCoin = { decimals: r.outDecimals, symbol: r.outSymbol };
            const perUnit = formatRate(r);
            return `  - ${r.inSymbol} to ${r.outSymbol}: up to ${formatAmount(r.maxPerTrade, inCoin)} per trade, ${formatAmount(r.maxPerEpoch, inCoin)} per epoch (${formatAmount(used, inCoin)} used), at least ${perUnit} ${r.outSymbol} per ${r.inSymbol}, until ${new Date(r.expiryMs).toISOString()}${Date.now() > r.expiryMs ? " (EXPIRED)" : ""}`;
          })
          .join("\n")}`
      : "Standing trade rules: none (every swap needs the owner's approval)",
  );
  return lines;
}

/** The rule's price floor as a human number: output units per one input unit. */
export function formatRate(r: Pick<TradeRuleInfo, "rateNum" | "rateDen" | "inDecimals" | "outDecimals">): string {
  // floor per 1 whole input coin = rateNum / rateDen * 10^inDecimals raw out, shown in whole out coins.
  const scaled = (r.rateNum * 10n ** BigInt(r.inDecimals) * 1_000_000n) / (r.rateDen * 10n ** BigInt(r.outDecimals));
  return formatUnits(scaled, 6);
}

type VaultSpendInput = {
  client: SuiGrpcClient;
  network: SuiNetwork;
  sender: string;
  recipient: string;
  amountMist: bigint;
};

/**
 * Validates the request against the vault's current state for a clear error message,
 * then builds the spend transaction. The contract re-checks every rule on-chain, so
 * these client checks are a convenience, not the security boundary.
 */
export async function prepareVaultSpend(input: VaultSpendInput) {
  assertTestnet(input.network);
  if (input.amountMist <= 0n) {
    throw new Error("Amount must be greater than 0.");
  }
  const config = vaultConfig();
  const recipient = requireAddress(input.recipient);
  const sender = requireAddress(input.sender);

  const status = await getVaultStatus(input.client, config);
  const sui = (mist: bigint) => `${formatUnits(mist, SUI_DECIMALS)} SUI`;
  if (status.paused) {
    throw new Error("The vault is paused by its owner. No spends are allowed.");
  }
  if (input.amountMist > status.perTxLimitMist) {
    throw new Error(
      `Over the vault's per-spend limit. Requested ${sui(input.amountMist)}, limit is ${sui(status.perTxLimitMist)}. ` +
        `Larger payments need the owner's approval: call propose_spend instead.`,
    );
  }
  if (input.amountMist > status.balanceMist) {
    throw new Error(
      `The vault only holds ${sui(status.balanceMist)}, which is less than the requested ${sui(input.amountMist)}.`,
    );
  }
  const verdict = classifySpend(status, recipient, input.amountMist);
  if (!verdict.direct) {
    throw new Error(
      `This payment is outside the spending policy: ${verdict.reason}. Nothing was sent. ` +
        `It needs the owner's approval: call propose_spend, then wait for them to approve it.`,
    );
  }

  const tx = new Transaction();
  tx.setSender(sender);
  tx.moveCall({
    target: `${config.packageId}::spending_vault::spend`,
    arguments: [
      tx.object(config.agentCapId),
      tx.object(config.vaultId),
      tx.pure.address(recipient),
      tx.pure.u64(input.amountMist),
    ],
  });
  return { tx, sender, recipient, status };
}

export interface VaultDryRunResult {
  sender: string;
  recipient: string;
  amountMist: bigint;
  vault: VaultStatus;
  success: boolean;
  error: string | null;
  gasMist: bigint | null;
}

/** Simulates the vault spend on the node. Nothing is signed or submitted. */
export async function dryRunVaultSpend(input: VaultSpendInput): Promise<VaultDryRunResult> {
  const { tx, sender, recipient, status } = await prepareVaultSpend(input);
  const result = await input.client.simulateTransaction({
    transaction: tx,
    include: { effects: true },
  });
  const outcome = result.$kind === "FailedTransaction" ? result.FailedTransaction : result.Transaction;
  const gas = outcome.effects?.gasUsed ?? null;
  return {
    sender,
    recipient,
    amountMist: input.amountMist,
    vault: status,
    success: result.$kind === "Transaction",
    error: result.$kind === "FailedTransaction" ? (outcome.status.error?.message ?? "Simulation failed.") : null,
    gasMist: gas ? netGasMist(gas) : null,
  };
}

export function formatVaultDryRun(result: VaultDryRunResult): string {
  const sui = (mist: bigint) => `${formatUnits(mist, SUI_DECIMALS)} SUI`;
  const lines = [
    `DRY RUN (nothing was signed or submitted)`,
    `Status: ${result.success ? "would succeed" : `would FAIL: ${result.error}`}`,
    `Agent wallet: ${result.sender}`,
    `Pays: ${result.recipient}`,
    `Amount: ${sui(result.amountMist)} from the vault (vault holds ${sui(result.vault.balanceMist)}, limit ${sui(result.vault.perTxLimitMist)} per spend)`,
  ];
  if (result.gasMist !== null) lines.push(`Estimated gas (paid by the agent wallet): ${sui(result.gasMist)}`);
  return lines.join("\n");
}

/** Spends from the vault to `recipient`. The agent wallet only pays gas. */
export async function vaultSpend(input: Omit<VaultSpendInput, "sender"> & { signer: Ed25519Keypair }): Promise<TransferReceipt> {
  const { tx, sender, recipient } = await prepareVaultSpend({ ...input, sender: input.signer.toSuiAddress() });

  const submitted = await input.client.signAndExecuteTransaction({
    transaction: tx,
    signer: input.signer,
    include: { effects: true, balanceChanges: true },
  });
  if (submitted.$kind === "FailedTransaction") {
    throw new Error(submitted.FailedTransaction.status.error?.message ?? "Transaction failed.");
  }

  const settled = await input.client.waitForTransaction({
    result: submitted,
    include: { effects: true, balanceChanges: true },
    timeout: 60_000,
  });
  if (settled.$kind === "FailedTransaction") {
    throw new Error(settled.FailedTransaction.status.error?.message ?? "Transaction failed.");
  }

  const executed = settled.Transaction;
  const gas = executed.effects?.gasUsed;
  return {
    digest: executed.digest,
    sender,
    recipient,
    amountMist: input.amountMist,
    gasMist: gas ? netGasMist(gas) : null,
    explorerUrl: explorerTxUrl(input.network, executed.digest),
    balanceChanges: (executed.balanceChanges ?? []).map((change) => ({
      address: change.address,
      coinType: change.coinType,
      amount: change.amount,
    })),
  };
}

export function formatVaultSpendReceipt(receipt: TransferReceipt): string {
  const sui = (mist: bigint) => `${formatUnits(mist, SUI_DECIMALS)} SUI`;
  const lines = [
    `Paid ${sui(receipt.amountMist)} from the spending vault`,
    `To: ${receipt.recipient}`,
    `Signed by agent wallet: ${receipt.sender}`,
    `Digest: ${receipt.digest}`,
    `Explorer: ${receipt.explorerUrl}`,
  ];
  if (receipt.gasMist !== null) lines.push(`Gas (paid by the agent wallet): ${sui(receipt.gasMist)}`);
  return lines.join("\n");
}

// === Staking ===

type VaultStakeInput = {
  client: SuiGrpcClient;
  network: SuiNetwork;
  sender: string;
  validator: string;
  amountMist: bigint;
};

/**
 * Client-side checks for a clear error message, then builds the stake transaction.
 * The contract re-checks every rule (allowlist, pause, revoke, balance), so these are a
 * convenience and not the security boundary. The StakedSui receipt is kept inside the
 * vault by the contract: this wallet never holds it and cannot unstake it.
 */
export async function prepareVaultStake(input: VaultStakeInput) {
  assertTestnet(input.network);
  const config = vaultConfig();
  const validator = requireAddress(input.validator);
  const sender = requireAddress(input.sender);
  const sui = (mist: bigint) => `${formatUnits(mist, SUI_DECIMALS)} SUI`;

  if (input.amountMist < MIN_STAKE_MIST) {
    throw new Error(`Sui requires at least ${sui(MIN_STAKE_MIST)} per stake. Requested ${sui(input.amountMist)}.`);
  }
  const status = await getVaultStatus(input.client, config);
  if (status.paused) {
    throw new Error("The vault is paused by its owner. No spends or stakes are allowed.");
  }
  if (!status.allowedValidators.includes(validator)) {
    throw new Error(
      `Validator ${validator} is not on the vault's allowlist. Allowed: ${status.allowedValidators.join(", ") || "none"}. Only the vault owner can add validators.`,
    );
  }
  if (input.amountMist > status.balanceMist) {
    throw new Error(`The vault only holds ${sui(status.balanceMist)}, which is less than the requested ${sui(input.amountMist)}.`);
  }
  const kp = status.stakePolicy;
  if (kp) {
    if (kp.stakedTotalMist + input.amountMist > kp.maxStakedMist) {
      throw new Error(
        `Over the vault's stake limit: ${sui(kp.stakedTotalMist)} is already staked and the owner allows at most ${sui(kp.maxStakedMist)}.`,
      );
    }
    if (kp.positions + 1n > kp.maxPositions) {
      throw new Error(`The vault already has ${kp.positions} staking positions, the most the owner allows.`);
    }
    if (status.balanceMist - input.amountMist < kp.minReserveMist) {
      throw new Error(
        `Staking ${sui(input.amountMist)} would leave less than the ${sui(kp.minReserveMist)} the owner wants kept liquid in the vault.`,
      );
    }
  }

  const tx = new Transaction();
  tx.setSender(sender);
  tx.moveCall({
    target: `${config.packageId}::spending_vault::stake`,
    arguments: [
      tx.object(config.agentCapId),
      tx.object(config.vaultId),
      tx.object(SUI_SYSTEM_STATE_OBJECT_ID),
      tx.pure.address(validator),
      tx.pure.u64(input.amountMist),
    ],
  });
  return { tx, sender, validator, status };
}

export interface VaultStakeDryRunResult {
  sender: string;
  validator: string;
  amountMist: bigint;
  vault: VaultStatus;
  success: boolean;
  error: string | null;
  gasMist: bigint | null;
}

/** Simulates the stake on the node. Nothing is signed or submitted. */
export async function dryRunVaultStake(input: VaultStakeInput): Promise<VaultStakeDryRunResult> {
  const { tx, sender, validator, status } = await prepareVaultStake(input);
  const result = await input.client.simulateTransaction({ transaction: tx, include: { effects: true } });
  const outcome = result.$kind === "FailedTransaction" ? result.FailedTransaction : result.Transaction;
  const gas = outcome.effects?.gasUsed ?? null;
  return {
    sender,
    validator,
    amountMist: input.amountMist,
    vault: status,
    success: result.$kind === "Transaction",
    error: result.$kind === "FailedTransaction" ? (outcome.status.error?.message ?? "Simulation failed.") : null,
    gasMist: gas ? netGasMist(gas) : null,
  };
}

export function formatVaultStakeDryRun(result: VaultStakeDryRunResult): string {
  const sui = (mist: bigint) => `${formatUnits(mist, SUI_DECIMALS)} SUI`;
  const lines = [
    `DRY RUN (nothing was signed or submitted)`,
    `Status: ${result.success ? "would succeed" : `would FAIL: ${result.error}`}`,
    `Agent wallet: ${result.sender}`,
    `Stakes: ${sui(result.amountMist)} from the vault with validator ${result.validator}`,
    `The staking receipt stays inside the vault; only the owner can unstake.`,
  ];
  if (result.gasMist !== null) lines.push(`Estimated gas (paid by the agent wallet): ${sui(result.gasMist)}`);
  return lines.join("\n");
}

export interface VaultStakeReceipt {
  digest: string;
  sender: string;
  validator: string;
  amountMist: bigint;
  stakedSuiId: string | null;
  gasMist: bigint | null;
  explorerUrl: string;
}

/** Stakes vault funds with an allowed validator. The agent wallet only pays gas. */
export async function vaultStake(input: Omit<VaultStakeInput, "sender"> & { signer: Ed25519Keypair }): Promise<VaultStakeReceipt> {
  const { tx, sender, validator } = await prepareVaultStake({ ...input, sender: input.signer.toSuiAddress() });

  const submitted = await input.client.signAndExecuteTransaction({
    transaction: tx,
    signer: input.signer,
    include: { effects: true },
  });
  if (submitted.$kind === "FailedTransaction") {
    throw new Error(submitted.FailedTransaction.status.error?.message ?? "Transaction failed.");
  }

  const settled = await input.client.waitForTransaction({
    result: submitted,
    include: { effects: true, events: true },
    timeout: 60_000,
  });
  if (settled.$kind === "FailedTransaction") {
    throw new Error(settled.FailedTransaction.status.error?.message ?? "Transaction failed.");
  }

  const executed = settled.Transaction;
  const gas = executed.effects?.gasUsed;
  const stakedEvent = executed.events?.find((event) => event.eventType.endsWith("::spending_vault::Staked"));
  const stakedSuiId = stakedEvent?.json?.staked_sui_id;
  return {
    digest: executed.digest,
    sender,
    validator,
    amountMist: input.amountMist,
    stakedSuiId: typeof stakedSuiId === "string" ? stakedSuiId : null,
    gasMist: gas ? netGasMist(gas) : null,
    explorerUrl: explorerTxUrl(input.network, executed.digest),
  };
}

export function formatVaultStakeReceipt(receipt: VaultStakeReceipt): string {
  const sui = (mist: bigint) => `${formatUnits(mist, SUI_DECIMALS)} SUI`;
  const lines = [
    `Staked ${sui(receipt.amountMist)} from the spending vault`,
    `Validator: ${receipt.validator}`,
    `Staking receipt (held by the vault): ${receipt.stakedSuiId ?? "see transaction events"}`,
    `Signed by agent wallet: ${receipt.sender}`,
    `Digest: ${receipt.digest}`,
    `Explorer: ${receipt.explorerUrl}`,
    `Staking takes effect next epoch. Only the vault owner can unstake.`,
  ];
  if (receipt.gasMist !== null) lines.push(`Gas (paid by the agent wallet): ${sui(receipt.gasMist)}`);
  return lines.join("\n");
}
