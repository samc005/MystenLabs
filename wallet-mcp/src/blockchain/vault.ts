import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  SUI_DECIMALS,
  SUI_SYSTEM_STATE_OBJECT_ID,
  toHex,
} from "@mysten/sui/utils";
import { assertTestnet, explorerTxUrl, vaultConfig, type VaultConfig } from "../config.js";
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
  /** Per-coin balances the owner has allocated for the agent to swap. */
  trading: TradingBalance[];
  /** Owner-approved trades the agent may still execute. */
  intents: IntentInfo[];
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
  const { allowedValidators, stakes, trading, intents } = await readVaultDynamicFields(client, config.vaultId);
  return {
    vaultId: config.vaultId,
    balanceMist: toBigInt(fields.balance, "balance"),
    perTxLimitMist: toBigInt(fields.per_tx_limit, "per_tx_limit"),
    totalSpentMist: toBigInt(fields.total_spent, "total_spent"),
    paused: fields.paused === true,
    allowedValidators,
    stakes,
    trading,
    intents,
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

/**
 * The allowlist and staking receipts live on the vault as dynamic fields (keeps the
 * Vault struct unchanged across upgrades). Keys are identified by their Move type name.
 */
async function readVaultDynamicFields(client: SuiGrpcClient, vaultId: string) {
  const allowedValidators: string[] = [];
  const stakedSuiIds: string[] = [];
  const tradingFields: { fieldId: string; coinType: string }[] = [];
  const intentIds: string[] = [];

  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<SuiGrpcClient["listDynamicFields"]>> = await client.listDynamicFields({
      parentId: vaultId,
      cursor,
    });
    for (const entry of page.dynamicFields) {
      if (entry.name.type.includes("::spending_vault::AllowedValidator")) {
        // struct AllowedValidator { validator: address } serializes to the 32 address bytes.
        allowedValidators.push(normalizeSuiAddress(`0x${toHex(entry.name.bcs)}`));
      } else if (entry.$kind === "DynamicObject" && entry.name.type.includes("::spending_vault::StakeKey")) {
        stakedSuiIds.push(entry.childId);
      } else if (entry.$kind === "DynamicField" && entry.name.type.includes("::spending_vault::TradingKey<")) {
        const [coinType] = typeArguments(entry.name.type);
        if (coinType) tradingFields.push({ fieldId: entry.fieldId, coinType });
      } else if (entry.$kind === "DynamicObject" && entry.name.type.includes("::spending_vault::IntentKey")) {
        intentIds.push(entry.childId);
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
  return { allowedValidators, stakes, trading, intents };
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
  ].join("\n");
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
      `Over the vault's per-spend limit. Requested ${sui(input.amountMist)}, limit is ${sui(status.perTxLimitMist)}.`,
    );
  }
  if (input.amountMist > status.balanceMist) {
    throw new Error(
      `The vault only holds ${sui(status.balanceMist)}, which is less than the requested ${sui(input.amountMist)}.`,
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
