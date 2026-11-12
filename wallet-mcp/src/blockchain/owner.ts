// Owner-side actions: everything that needs the vault's OwnerCap.
//
// This module is deliberately NOT imported by the MCP server or any MCP tool, so the
// agent has no tool that can reach it. It is used by `npm run owner` and by the UI's
// approve button (which runs that script). The owner key is read from the Sui CLI
// keystore; it never goes into wallet-mcp's own .wallet files.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Keypair } from "@mysten/sui/cryptography";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { SUI_SYSTEM_STATE_OBJECT_ID, normalizeSuiAddress } from "@mysten/sui/utils";
import { assertTestnet, explorerTxUrl, tradingConfig, vaultConfig } from "../config.js";
import type { SuiNetwork } from "./client.js";
import { formatAmount, parseUnits } from "./coins.js";
import { getDex } from "./dex.js";
import { isSpendProposal, requireProposal, updateProposal, type Proposal, type SpendProposal } from "./proposals.js";
import { netGasMist } from "./transfer.js";
import { getVaultStatus } from "./vault.js";
import { requireAddress } from "./address.js";

export function keystorePath(): string {
  return process.env.SUI_KEYSTORE_PATH ?? join(homedir(), ".sui", "sui_config", "sui.keystore");
}

/** The Sui CLI keystore is a JSON array of base64 strings: one flag byte, then a 32-byte secret. */
async function loadKeystore(): Promise<Keypair[]> {
  const path = keystorePath();
  let entries: unknown;
  try {
    entries = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Could not read the Sui keystore at ${path}. Set SUI_KEYSTORE_PATH to your keystore file.`);
  }
  if (!Array.isArray(entries)) throw new Error(`Unexpected keystore format at ${path}.`);
  const keypairs: Keypair[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const bytes = Buffer.from(entry, "base64");
    const secret = bytes.subarray(1);
    if (secret.length !== 32) continue;
    if (bytes[0] === 0) keypairs.push(Ed25519Keypair.fromSecretKey(secret));
    else if (bytes[0] === 1) keypairs.push(Secp256k1Keypair.fromSecretKey(secret));
    else if (bytes[0] === 2) keypairs.push(Secp256r1Keypair.fromSecretKey(secret));
  }
  return keypairs;
}

export interface OwnerContext {
  client: SuiGrpcClient;
  network: SuiNetwork;
  signer: Keypair;
  address: string;
  ownerCapId: string;
}

/** Finds the keystore key that holds this vault's OwnerCap. */
export async function loadOwnerContext(client: SuiGrpcClient, network: SuiNetwork): Promise<OwnerContext> {
  assertTestnet(network);
  const { vaultId } = vaultConfig();
  const { object: vault } = await client.getObject({ objectId: vaultId });
  const ownerCapType = vault.type.replace(/::spending_vault::Vault$/, "::spending_vault::OwnerCap");

  for (const signer of await loadKeystore()) {
    const address = signer.toSuiAddress();
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<SuiGrpcClient["listOwnedObjects"]>> = await client.listOwnedObjects({
        owner: address,
        type: ownerCapType,
        include: { json: true },
        cursor,
      });
      for (const object of page.objects) {
        const json = (object as { json?: Record<string, unknown> | null }).json;
        if (json && normalizeSuiAddress(String(json.vault_id)) === normalizeSuiAddress(vaultId)) {
          return { client, network, signer, address, ownerCapId: object.objectId };
        }
      }
      cursor = page.hasNextPage ? page.cursor : null;
    } while (cursor);
  }
  throw new Error(
    `No key in ${keystorePath()} holds the OwnerCap for vault ${vaultId}. ` +
      `Run this from the machine and Sui CLI profile that created the vault.`,
  );
}

export interface OwnerReceipt {
  digest: string;
  explorerUrl: string;
  gasMist: bigint | null;
  events: { type: string; json: Record<string, unknown> | null }[];
}

async function execute(ctx: OwnerContext, tx: Transaction): Promise<OwnerReceipt> {
  tx.setSender(ctx.address);
  const submitted = await ctx.client.signAndExecuteTransaction({
    transaction: tx,
    signer: ctx.signer,
    include: { effects: true },
  });
  if (submitted.$kind === "FailedTransaction") {
    throw new Error(submitted.FailedTransaction.status.error?.message ?? "Transaction failed.");
  }
  const settled = await ctx.client.waitForTransaction({
    result: submitted,
    include: { effects: true, events: true },
    timeout: 60_000,
  });
  if (settled.$kind === "FailedTransaction") {
    throw new Error(settled.FailedTransaction.status.error?.message ?? "Transaction failed.");
  }
  const executed = settled.Transaction;
  const gas = executed.effects?.gasUsed;
  return {
    digest: executed.digest,
    explorerUrl: explorerTxUrl(ctx.network, executed.digest),
    gasMist: gas ? netGasMist(gas) : null,
    events: (executed.events ?? []).map((event) => ({ type: event.eventType, json: event.json ?? null })),
  };
}

// === Trading sleeve ===

export async function allocateSui(ctx: OwnerContext, amountMist: bigint): Promise<OwnerReceipt> {
  const { packageId, vaultId } = vaultConfig();
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::spending_vault::allocate_sui_to_trading`,
    arguments: [tx.object(ctx.ownerCapId), tx.object(vaultId), tx.pure.u64(amountMist)],
  });
  return execute(ctx, tx);
}

export async function releaseSui(ctx: OwnerContext, amountMist: bigint): Promise<OwnerReceipt> {
  const { packageId, vaultId } = vaultConfig();
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::spending_vault::release_sui_from_trading`,
    arguments: [tx.object(ctx.ownerCapId), tx.object(vaultId), tx.pure.u64(amountMist)],
  });
  return execute(ctx, tx);
}

/** Add coins from the owner's wallet to the trading sleeve. */
export async function depositTrading(ctx: OwnerContext, coinType: string, amount: bigint): Promise<OwnerReceipt> {
  const { packageId, vaultId } = vaultConfig();
  const tx = new Transaction();
  const coin = coinWithBalance({ balance: amount, type: coinType })(tx);
  tx.moveCall({
    target: `${packageId}::spending_vault::deposit_trading`,
    typeArguments: [coinType],
    arguments: [tx.object(vaultId), coin],
  });
  return execute(ctx, tx);
}

/** Take coins from the trading sleeve back to the owner's wallet. */
export async function withdrawTrading(ctx: OwnerContext, coinType: string, amount: bigint): Promise<OwnerReceipt> {
  const { packageId, vaultId } = vaultConfig();
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::spending_vault::withdraw_trading`,
    typeArguments: [coinType],
    arguments: [tx.object(ctx.ownerCapId), tx.object(vaultId), tx.pure.u64(amount)],
  });
  return execute(ctx, tx);
}

// === Trade intents ===

export interface CreatedIntent extends OwnerReceipt {
  intentId: string;
  expiryMs: number;
}

/** Approve one trade on-chain. The agent can execute it once, before it expires. */
export async function createIntent(
  ctx: OwnerContext,
  input: { inType: string; outType: string; amountIn: bigint; minOut: bigint; ttlMs: number },
): Promise<CreatedIntent> {
  const { packageId, vaultId } = vaultConfig();
  const expiryMs = Date.now() + input.ttlMs;
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::spending_vault::create_intent`,
    typeArguments: [input.inType, input.outType],
    arguments: [
      tx.object(ctx.ownerCapId),
      tx.object(vaultId),
      tx.pure.u64(input.amountIn),
      tx.pure.u64(input.minOut),
      tx.pure.u64(expiryMs),
      tx.object.clock(),
    ],
  });
  const receipt = await execute(ctx, tx);
  const created = receipt.events.find((event) => event.type.includes("::spending_vault::IntentCreated"));
  const intentId = created?.json?.intent_id;
  if (typeof intentId !== "string") throw new Error("The intent was created but its ID was not in the events.");
  return { ...receipt, intentId, expiryMs };
}

export async function cancelIntent(ctx: OwnerContext, intentId: string): Promise<OwnerReceipt> {
  const { packageId, vaultId } = vaultConfig();
  const status = await getVaultStatus(ctx.client);
  const intent = status.intents.find((i) => i.intentId === intentId);
  if (!intent) throw new Error(`No open intent ${intentId}.`);
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::spending_vault::cancel_intent`,
    typeArguments: [intent.inType, intent.outType],
    arguments: [tx.object(ctx.ownerCapId), tx.object(vaultId), tx.pure.id(intentId)],
  });
  return execute(ctx, tx);
}

// === Proposals made by the agent in chat ===

/**
 * Approve a proposal: re-checks the vault and the market, then signs create_intent with
 * exactly the terms stored in the proposal (not anything the agent said in chat).
 */
export async function approveProposal(ctx: OwnerContext, proposalId: string): Promise<{ proposal: Proposal; receipt: CreatedIntent }> {
  const proposal = await requireProposal(proposalId);
  if (proposal.status !== "pending") {
    throw new Error(`Proposal ${proposal.id} is ${proposal.status}; only a pending proposal can be approved.`);
  }
  if (isSpendProposal(proposal)) return approveSpendProposal(ctx, proposal);
  const amountIn = BigInt(proposal.amountIn);
  const minOut = BigInt(proposal.minOut);

  const status = await getVaultStatus(ctx.client);
  if (status.paused) throw new Error("The vault is paused. Unpause it before approving trades.");
  const have = status.trading.find((t) => t.coinType === proposal.inType)?.raw ?? 0n;
  if (have < amountIn) {
    throw new Error(`The trading sleeve only holds ${formatAmount(have, { decimals: proposal.inDecimals, symbol: proposal.inSymbol })}.`);
  }
  const now = await getDex().quote(ctx.client, proposal.inType, proposal.outType, amountIn);
  if (now < minOut) {
    throw new Error(
      `The market moved since this was proposed: it now returns ${formatAmount(now, { decimals: proposal.outDecimals, symbol: proposal.outSymbol })}, ` +
        `below the minimum ${formatAmount(minOut, { decimals: proposal.outDecimals, symbol: proposal.outSymbol })}. Ask the agent for a fresh proposal.`,
    );
  }

  const receipt = await createIntent(ctx, {
    inType: proposal.inType,
    outType: proposal.outType,
    amountIn,
    minOut,
    ttlMs: proposal.intentTtlMs,
  });
  const updated = await updateProposal(proposal.id, {
    status: "approved",
    intentId: receipt.intentId,
    intentExpiryMs: receipt.expiryMs,
    approvalDigest: receipt.digest,
  });
  return { proposal: updated, receipt };
}

/** Approve a payment outside the policy: signs create_spend_intent for exactly the stored terms. */
async function approveSpendProposal(
  ctx: OwnerContext,
  proposal: SpendProposal,
): Promise<{ proposal: Proposal; receipt: CreatedIntent }> {
  const amountMist = BigInt(proposal.amountMist);
  const status = await getVaultStatus(ctx.client);
  if (status.paused) throw new Error("The vault is paused. Unpause it before approving payments.");
  if (status.balanceMist < amountMist) {
    throw new Error(`The vault only holds ${formatAmount(status.balanceMist, { decimals: 9, symbol: "SUI" })}.`);
  }
  const receipt = await createSpendIntent(ctx, {
    recipient: proposal.recipient,
    amountMist,
    ttlMs: proposal.intentTtlMs,
  });
  const updated = await updateProposal(proposal.id, {
    status: "approved",
    intentId: receipt.intentId,
    intentExpiryMs: receipt.expiryMs,
    approvalDigest: receipt.digest,
  });
  return { proposal: updated, receipt };
}

/** Approve one payment on-chain, to this recipient and amount only. The agent can run it once. */
export async function createSpendIntent(
  ctx: OwnerContext,
  input: { recipient: string; amountMist: bigint; ttlMs: number },
): Promise<CreatedIntent> {
  const { packageId, vaultId } = vaultConfig();
  const expiryMs = Date.now() + input.ttlMs;
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::spending_vault::create_spend_intent`,
    arguments: [
      tx.object(ctx.ownerCapId),
      tx.object(vaultId),
      tx.pure.address(requireAddress(input.recipient)),
      tx.pure.u64(input.amountMist),
      tx.pure.u64(expiryMs),
      tx.object.clock(),
    ],
  });
  const receipt = await execute(ctx, tx);
  const created = receipt.events.find((event) => event.type.includes("::spending_vault::SpendIntentCreated"));
  const intentId = created?.json?.intent_id;
  if (typeof intentId !== "string") throw new Error("The approval was created but its ID was not in the events.");
  return { ...receipt, intentId, expiryMs };
}

export async function cancelSpendIntent(ctx: OwnerContext, intentId: string): Promise<OwnerReceipt> {
  const { packageId, vaultId } = vaultConfig();
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::spending_vault::cancel_spend_intent`,
    arguments: [tx.object(ctx.ownerCapId), tx.object(vaultId), tx.pure.id(intentId)],
  });
  return execute(ctx, tx);
}

// === Policies: limits the agent cannot exceed ===

/** Cap total direct spending per epoch (about a day) and optionally restrict who can be paid. */
export async function setSpendPolicy(
  ctx: OwnerContext,
  input: { dailyCapMist: bigint; enforceRecipients: boolean },
): Promise<OwnerReceipt> {
  const { packageId, vaultId } = vaultConfig();
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::spending_vault::set_spend_policy`,
    arguments: [
      tx.object(ctx.ownerCapId),
      tx.object(vaultId),
      tx.pure.u64(input.dailyCapMist),
      tx.pure.bool(input.enforceRecipients),
    ],
  });
  return execute(ctx, tx);
}

export async function clearSpendPolicy(ctx: OwnerContext): Promise<OwnerReceipt> {
  const { packageId, vaultId } = vaultConfig();
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::spending_vault::clear_spend_policy`,
    arguments: [tx.object(ctx.ownerCapId), tx.object(vaultId)],
  });
  return execute(ctx, tx);
}

export async function setRecipientAllowed(ctx: OwnerContext, recipient: string, allow: boolean): Promise<OwnerReceipt> {
  const { packageId, vaultId } = vaultConfig();
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::spending_vault::${allow ? "allow_recipient" : "disallow_recipient"}`,
    arguments: [tx.object(ctx.ownerCapId), tx.object(vaultId), tx.pure.address(requireAddress(recipient))],
  });
  return execute(ctx, tx);
}

/**
 * Cap staking: total staked, a liquid reserve the agent cannot stake into, and the number
 * of positions. Counters for positions opened before the policy existed are synced from the
 * vault's actual receipts, so the caps are measured against what is really staked.
 */
export async function setStakePolicy(
  ctx: OwnerContext,
  input: { maxStakedMist: bigint; minReserveMist: bigint; maxPositions: bigint },
): Promise<OwnerReceipt> {
  const { packageId, vaultId } = vaultConfig();
  const status = await getVaultStatus(ctx.client);
  const actualTotal = status.stakes.reduce((sum, s) => sum + s.principalMist, 0n);
  const actualPositions = BigInt(status.stakes.length);
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::spending_vault::set_stake_policy`,
    arguments: [
      tx.object(ctx.ownerCapId),
      tx.object(vaultId),
      tx.pure.u64(input.maxStakedMist),
      tx.pure.u64(input.minReserveMist),
      tx.pure.u64(input.maxPositions),
    ],
  });
  tx.moveCall({
    target: `${packageId}::spending_vault::sync_stake_counters`,
    arguments: [tx.object(ctx.ownerCapId), tx.object(vaultId), tx.pure.u64(actualTotal), tx.pure.u64(actualPositions)],
  });
  return execute(ctx, tx);
}

export async function clearStakePolicy(ctx: OwnerContext): Promise<OwnerReceipt> {
  const { packageId, vaultId } = vaultConfig();
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::spending_vault::clear_stake_policy`,
    arguments: [tx.object(ctx.ownerCapId), tx.object(vaultId)],
  });
  return execute(ctx, tx);
}

// === Standing trade rules ===

/**
 * Convert a human price ("1.8" tUSDC per 1 SUI) to the raw ratio the contract stores:
 * raw out per raw in = price * 10^outDecimals / 10^inDecimals.
 */
export function rateToRaw(price: string, inDecimals: number, outDecimals: number): { num: bigint; den: bigint } {
  const num = parseUnits(price, outDecimals);
  if (num <= 0n) throw new Error("The price floor must be greater than 0.");
  return { num, den: 10n ** BigInt(inDecimals) };
}

/**
 * Let the agent swap `inType` for `outType` with no per-trade approval, inside these limits:
 * each trade at most `maxPerTrade`, at most `maxPerEpoch` per epoch, and never for less than
 * the price floor. The price floor is the owner's number; the contract has no price oracle.
 */
export async function setTradeRule(
  ctx: OwnerContext,
  input: {
    inType: string;
    outType: string;
    maxPerTrade: bigint;
    maxPerEpoch: bigint;
    rateNum: bigint;
    rateDen: bigint;
    ttlMs: number;
  },
): Promise<OwnerReceipt & { expiryMs: number }> {
  const { packageId, vaultId } = vaultConfig();
  const expiryMs = Date.now() + input.ttlMs;
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::spending_vault::set_trade_rule`,
    typeArguments: [input.inType, input.outType],
    arguments: [
      tx.object(ctx.ownerCapId),
      tx.object(vaultId),
      tx.pure.u64(input.maxPerTrade),
      tx.pure.u64(input.maxPerEpoch),
      tx.pure.u64(input.rateNum),
      tx.pure.u64(input.rateDen),
      tx.pure.u64(expiryMs),
      tx.object.clock(),
    ],
  });
  return { ...(await execute(ctx, tx)), expiryMs };
}

export async function removeTradeRule(ctx: OwnerContext, inType: string, outType: string): Promise<OwnerReceipt> {
  const { packageId, vaultId } = vaultConfig();
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::spending_vault::remove_trade_rule`,
    typeArguments: [inType, outType],
    arguments: [tx.object(ctx.ownerCapId), tx.object(vaultId)],
  });
  return execute(ctx, tx);
}

export async function rejectProposal(proposalId: string): Promise<Proposal> {
  const proposal = await requireProposal(proposalId);
  if (proposal.status !== "pending") {
    throw new Error(`Proposal ${proposal.id} is ${proposal.status}; only a pending proposal can be rejected.`);
  }
  return updateProposal(proposal.id, { status: "rejected" });
}

// === Staking (owner side) ===

export async function allowValidator(ctx: OwnerContext, validator: string, allow: boolean): Promise<OwnerReceipt> {
  const { packageId, vaultId } = vaultConfig();
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::spending_vault::${allow ? "allow_validator" : "disallow_validator"}`,
    arguments: [tx.object(ctx.ownerCapId), tx.object(vaultId), tx.pure.address(requireAddress(validator))],
  });
  return execute(ctx, tx);
}

/** Unstake a position the agent opened. Principal and rewards return to the vault's balance. */
export async function unstake(ctx: OwnerContext, stakedSuiId: string): Promise<OwnerReceipt> {
  const { packageId, vaultId } = vaultConfig();
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::spending_vault::unstake`,
    arguments: [
      tx.object(ctx.ownerCapId),
      tx.object(vaultId),
      tx.object(SUI_SYSTEM_STATE_OBJECT_ID),
      tx.pure.id(stakedSuiId),
    ],
  });
  return execute(ctx, tx);
}

// === Mock pool admin (testnet only) ===

/** Move the mock pool's price so you can watch trades gain or lose value. tUSDC per 1 SUI. */
export async function setPoolPrice(ctx: OwnerContext, usdcPerSui: string): Promise<OwnerReceipt & { price: bigint }> {
  const { poolPackageId, poolId } = tradingConfig();
  const price = parseUnits(usdcPerSui, 6);
  if (price <= 0n) throw new Error("Price must be greater than 0.");
  const owned = await ctx.client.listOwnedObjects({
    owner: ctx.address,
    type: `${poolPackageId}::test_usdc::AdminCap`,
    limit: 1,
  });
  const adminCap = owned.objects[0];
  if (!adminCap) throw new Error("This key does not hold the mock pool's AdminCap.");
  const tx = new Transaction();
  tx.moveCall({
    target: `${poolPackageId}::test_usdc::set_price`,
    arguments: [tx.object(adminCap.objectId), tx.object(poolId), tx.pure.u64(price)],
  });
  return { ...(await execute(ctx, tx)), price };
}