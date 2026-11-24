// "What Cipher can do": the owner turns staking and swaps on or off for the agent, with the limits
// the contract requires for each. One owner transaction sets everything; the contract enforces it.
//
//   Staking: the staking switch, a stake policy (most staked in total, SUI always kept unstaked,
//   number of stakes), and the validators Cipher may stake with.
//   Swaps:   the trading switch, a standing SUI -> tUSDC rule (most per swap, most per epoch,
//   worst accepted price, end date), and SUI set aside in the vault's trading balance. Swaps only
//   ever use that trading balance.

import { Transaction } from "@mysten/sui/transactions";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import type { VaultPolicy } from "./owner-tx";

const MODULE = "spending_vault";
const MIST_PER_SUI = 1_000_000_000n;
const MICRO_PER_USDC = 1_000_000n;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The testnet pool's coin. Override with NEXT_PUBLIC_SUI_POOL_PACKAGE_ID to match wallet-mcp. */
export const POOL_PACKAGE_ID =
  process.env.NEXT_PUBLIC_SUI_POOL_PACKAGE_ID ?? "0x9ce5995a4f4962e4091aa89da0197fd06b972cebc82593ca41624d37392186a4";
export const TUSDC_TYPE = `${POOL_PACKAGE_ID}::test_usdc::TEST_USDC`;
export const SUI_TYPE = "0x2::sui::SUI";

export interface AgentPermissionsForm {
  staking: boolean;
  /** SUI amounts as decimal strings, as typed. */
  maxStaked: string;
  minReserve: string;
  maxPositions: string;
  validators: string[];
  trading: boolean;
  maxPerSwap: string;
  maxPerDay: string;
  /** Worst price Cipher may accept, in tUSDC per SUI. */
  minUsdcPerSui: string;
  ruleDays: string;
  /** SUI to move from the vault into its trading balance now. */
  addToTrading: string;
}

export function permissionsFormFrom(policy: VaultPolicy): AgentPermissionsForm {
  const sui = (mist: bigint) => formatDecimal(mist, 9);
  const rule = policy.swapRule;
  return {
    staking: policy.agent?.staking === true,
    maxStaked: policy.stake ? sui(policy.stake.maxStakedMist) : "2",
    minReserve: policy.stake ? sui(policy.stake.minReserveMist) : "0.1",
    maxPositions: policy.stake ? policy.stake.maxPositions.toString() : "3",
    validators: [...(policy.allowedValidators ?? [])],
    trading: policy.agent?.trading === true,
    maxPerSwap: rule ? sui(rule.maxPerTradeMist) : "0.5",
    maxPerDay: rule ? sui(rule.maxPerEpochMist) : "1",
    // rate is micro-tUSDC per MIST; tUSDC per SUI = num / den * 1e9 / 1e6.
    minUsdcPerSui: rule ? formatDecimal((rule.rateNum * MIST_PER_SUI) / rule.rateDen, 6) : "1.9",
    ruleDays: "30",
    addToTrading: "0",
  };
}

export function formatDecimal(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function parseDecimal(value: string, decimals: number, label: string): bigint {
  const trimmed = value.trim();
  const match = trimmed.match(new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimals}}))?$`));
  if (!match) throw new Error(`${label}: enter a number with up to ${decimals} decimals.`);
  return BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt((match[2] ?? "").padEnd(decimals, "0") || "0");
}

export interface AgentPermissionsChanges {
  payments: boolean;
  staking: boolean;
  trading: boolean;
  stakePolicy: { maxStakedMist: bigint; minReserveMist: bigint; maxPositions: bigint } | null;
  allowValidators: string[];
  disallowValidators: string[];
  swapRule: { maxPerTradeMist: bigint; maxPerEpochMist: bigint; rateNum: bigint; rateDen: bigint; expiryMs: bigint } | null;
  addToTradingMist: bigint;
}

/** Turns the form into exact on-chain changes. Throws a readable error for bad input. */
export function permissionChanges(form: AgentPermissionsForm, policy: VaultPolicy, now = Date.now()): AgentPermissionsChanges {
  const validators = form.validators.map((address) => {
    if (!isValidSuiAddress(normalizeSuiAddress(address)) || !/^0x[0-9a-fA-F]{1,64}$/.test(address)) throw new Error("A validator address is not valid.");
    return normalizeSuiAddress(address);
  });
  const current = new Set(policy.allowedValidators ?? []);
  const wanted = new Set(validators);

  let stakePolicy: AgentPermissionsChanges["stakePolicy"] = null;
  if (form.staking) {
    const maxPositions = BigInt(/^[1-9][0-9]{0,2}$/.test(form.maxPositions.trim()) ? form.maxPositions.trim() : "0");
    if (maxPositions <= 0n) throw new Error("Number of stakes: enter a whole number from 1 to 999.");
    stakePolicy = {
      maxStakedMist: parseDecimal(form.maxStaked, 9, "Most staked"),
      minReserveMist: parseDecimal(form.minReserve, 9, "Always keep unstaked"),
      maxPositions,
    };
    if (stakePolicy.maxStakedMist < MIST_PER_SUI) throw new Error("Most staked must be at least 1 SUI, Sui's minimum stake.");
    if (wanted.size === 0) throw new Error("Pick at least one validator Cipher may stake with.");
  }

  let swapRule: AgentPermissionsChanges["swapRule"] = null;
  if (form.trading) {
    const maxPerTradeMist = parseDecimal(form.maxPerSwap, 9, "Most per swap");
    const maxPerEpochMist = parseDecimal(form.maxPerDay, 9, "Most per day");
    const microPerSui = parseDecimal(form.minUsdcPerSui, 6, "Worst price");
    const days = Number(form.ruleDays.trim());
    if (maxPerTradeMist <= 0n) throw new Error("Most per swap must be more than zero.");
    if (maxPerEpochMist < maxPerTradeMist) throw new Error("Most per day must be at least the most per swap.");
    if (microPerSui <= 0n) throw new Error("Worst price must be more than zero.");
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("Rule length: 1 to 365 days.");
    // min_out (micro-tUSDC) >= amount_in (MIST) * num / den.
    swapRule = { maxPerTradeMist, maxPerEpochMist, rateNum: microPerSui, rateDen: MIST_PER_SUI, expiryMs: BigInt(now + days * DAY_MS) };
  }
  const addToTradingMist = form.trading ? parseDecimal(form.addToTrading || "0", 9, "Add to trading balance") : 0n;
  if (policy.balanceMist !== undefined && addToTradingMist > policy.balanceMist) {
    throw new Error(`Your vault holds ${formatDecimal(policy.balanceMist, 9)} SUI, so it can't move ${formatDecimal(addToTradingMist, 9)} SUI into trading. Add money to the vault first.`);
  }

  return {
    payments: policy.agent?.payments ?? true,
    staking: form.staking,
    trading: form.trading,
    stakePolicy,
    allowValidators: form.staking ? [...wanted].filter((v) => !current.has(v)) : [],
    // Turning staking off keeps the validator list, so turning it back on is one switch.
    disallowValidators: form.staking ? [...current].filter((v) => !wanted.has(v)) : [],
    swapRule,
    addToTradingMist,
  };
}

/** One owner transaction for every change. Pure, so it is unit-tested. */
export function buildAgentPermissionsTx(
  changes: AgentPermissionsChanges,
  vault: { packageId: string; vaultId: string; ownerCapId: string },
): Transaction {
  const tx = new Transaction();
  const call = (name: string) => `${vault.packageId}::${MODULE}::${name}`;
  const cap = tx.object(vault.ownerCapId);
  const v = tx.object(vault.vaultId);
  if (changes.stakePolicy) {
    tx.moveCall({
      target: call("set_stake_policy"),
      arguments: [cap, v, tx.pure.u64(changes.stakePolicy.maxStakedMist), tx.pure.u64(changes.stakePolicy.minReserveMist), tx.pure.u64(changes.stakePolicy.maxPositions)],
    });
  }
  for (const validator of changes.allowValidators) {
    tx.moveCall({ target: call("allow_validator"), arguments: [cap, v, tx.pure.address(validator)] });
  }
  for (const validator of changes.disallowValidators) {
    tx.moveCall({ target: call("disallow_validator"), arguments: [cap, v, tx.pure.address(validator)] });
  }
  if (changes.swapRule) {
    tx.moveCall({
      target: call("set_trade_rule"),
      typeArguments: [SUI_TYPE, TUSDC_TYPE],
      arguments: [
        cap,
        v,
        tx.pure.u64(changes.swapRule.maxPerTradeMist),
        tx.pure.u64(changes.swapRule.maxPerEpochMist),
        tx.pure.u64(changes.swapRule.rateNum),
        tx.pure.u64(changes.swapRule.rateDen),
        tx.pure.u64(changes.swapRule.expiryMs),
        tx.object.clock(),
      ],
    });
  }
  if (changes.addToTradingMist > 0n) {
    tx.moveCall({ target: call("allocate_sui_to_trading"), arguments: [cap, v, tx.pure.u64(changes.addToTradingMist)] });
  }
  // Last, so the switches only turn on once their limits are in place.
  tx.moveCall({
    target: call("set_agent_security_policy"),
    arguments: [cap, v, tx.pure.bool(changes.payments), tx.pure.bool(changes.staking), tx.pure.bool(changes.trading)],
  });
  return tx;
}

/** The passkey payload for saving these permissions. */
export function permissionsApproval(vaultId: string) {
  return { action: "owner-agent-permissions", vaultId: vaultId.toLowerCase() };
}
