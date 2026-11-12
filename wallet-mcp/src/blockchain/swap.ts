import { requireAddress } from "./address.js";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { assertTestnet, explorerTxUrl, vaultConfig } from "../config.js";
import type { SuiNetwork } from "./client.js";
import { formatAmount, getCoinInfo, parseUnits, resolveCoinType } from "./coins.js";
import { getDex } from "./dex.js";
import {
  createProposal,
  describeProposal,
  isSwapProposal,
  requireProposal,
  updateProposal,
  type Proposal,
  type SwapProposal,
} from "./proposals.js";
import { netGasMist } from "./transfer.js";
import { evaluateTradeRule, getVaultStatus, type IntentInfo, type VaultStatus } from "./vault.js";

/** Shown in place of an intent ID when a swap runs under a standing trade rule. */
const STANDING_RULE_LABEL = "standing trade rule";

/** Default and maximum slippage the agent may propose, in basis points. */
export const DEFAULT_SLIPPAGE_BPS = 100;
export const MAX_SLIPPAGE_BPS = 500;

export interface SwapQuote {
  inType: string;
  outType: string;
  inSymbol: string;
  outSymbol: string;
  inDecimals: number;
  outDecimals: number;
  amountIn: bigint;
  amountOut: bigint;
  dex: string;
}

/** Read-only: what would selling `amount` of `sell` for `buy` return right now? */
export async function quoteSwap(
  client: SuiGrpcClient,
  sell: string,
  buy: string,
  amount: string,
): Promise<SwapQuote> {
  const inType = resolveCoinType(sell);
  const outType = resolveCoinType(buy);
  if (inType === outType) throw new Error("Choose two different coins to swap.");
  const [inInfo, outInfo] = await Promise.all([getCoinInfo(client, inType), getCoinInfo(client, outType)]);
  const amountIn = parseUnits(amount, inInfo.decimals);
  if (amountIn <= 0n) throw new Error("Amount must be greater than 0.");
  const dex = getDex();
  const amountOut = await dex.quote(client, inType, outType, amountIn);
  return {
    inType,
    outType,
    inSymbol: inInfo.symbol,
    outSymbol: outInfo.symbol,
    inDecimals: inInfo.decimals,
    outDecimals: outInfo.decimals,
    amountIn,
    amountOut,
    dex: dex.name,
  };
}

export function formatQuote(q: SwapQuote): string {
  const rate = Number(q.amountOut) / 10 ** q.outDecimals / (Number(q.amountIn) / 10 ** q.inDecimals);
  return [
    `Quote (${q.dex}): sell ${formatAmount(q.amountIn, { decimals: q.inDecimals, symbol: q.inSymbol })}`,
    `Expected: ${formatAmount(q.amountOut, { decimals: q.outDecimals, symbol: q.outSymbol })} (about ${rate.toPrecision(6)} ${q.outSymbol} per ${q.inSymbol}, fee included)`,
    `This is a quote only. Nothing has been proposed or traded.`,
  ].join("\n");
}

/** Sleeve balance of a coin type, 0 if the owner has not allocated any. */
function sleeveBalance(status: VaultStatus, coinType: string): bigint {
  return status.trading.find((t) => t.coinType === coinType)?.raw ?? 0n;
}

/**
 * Records a trade for the owner to approve. Nothing moves and nothing is signed: the swap
 * can only happen after the owner approves, which creates the on-chain Intent.
 */
export async function proposeTrade(
  client: SuiGrpcClient,
  input: { sell: string; buy: string; amount: string; slippageBps?: number },
): Promise<SwapProposal> {
  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(`Slippage must be a whole number of basis points from 1 to ${MAX_SLIPPAGE_BPS}.`);
  }
  const quote = await quoteSwap(client, input.sell, input.buy, input.amount);
  const status = await getVaultStatus(client);
  if (status.paused) throw new Error("The vault is paused by its owner. No trades are possible.");

  const available = sleeveBalance(status, quote.inType);
  if (available < quote.amountIn) {
    throw new Error(
      `The trading sleeve holds ${formatAmount(available, { decimals: quote.inDecimals, symbol: quote.inSymbol })}, ` +
        `less than the ${formatAmount(quote.amountIn, { decimals: quote.inDecimals, symbol: quote.inSymbol })} to sell. ` +
        `The owner must allocate funds to the sleeve first (npm run owner -- allocate <amount>).`,
    );
  }

  const minOut = (quote.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minOut <= 0n) throw new Error("That amount is too small to trade.");

  // A standing trade rule can pre-approve this trade: inside its size, epoch total and
  // price floor the agent needs no per-trade approval. Otherwise the owner must approve.
  const verdict = evaluateTradeRule(status, {
    inType: quote.inType,
    outType: quote.outType,
    amountIn: quote.amountIn,
    minOut,
  });

  return createProposal({
    dex: quote.dex,
    inType: quote.inType,
    outType: quote.outType,
    inSymbol: quote.inSymbol,
    outSymbol: quote.outSymbol,
    inDecimals: quote.inDecimals,
    outDecimals: quote.outDecimals,
    amountIn: quote.amountIn.toString(),
    quotedOut: quote.amountOut.toString(),
    minOut: minOut.toString(),
    slippageBps,
    ...(verdict.covered ? { auto: true } : verdict.rule ? { ruleNote: verdict.reason } : {}),
  });
}

/** The terms of a swap run under a standing trade rule (no on-chain intent). */
export interface StandingTerms {
  inType: string;
  outType: string;
  amountIn: bigint;
  minOut: bigint;
}

type SwapInput = {
  client: SuiGrpcClient;
  network: SuiNetwork;
  sender: string;
} & ({ intentId: string; standing?: undefined } | { standing: StandingTerms; intentId?: undefined });

/**
 * Validates against current state for a clear error, then builds the swap PTB:
 *   begin_swap -> DEX call -> finish_swap
 * The contract re-checks everything on-chain; these checks are a convenience, not the
 * security boundary. If the PTB does not call finish_swap it cannot execute at all.
 */
export async function prepareSwap(input: SwapInput) {
  assertTestnet(input.network);
  const config = vaultConfig();
  const sender = requireAddress(input.sender);
  const status = await getVaultStatus(input.client, config);
  if (status.paused) throw new Error("The vault is paused by its owner. No trades are allowed.");

  let intent: IntentInfo;
  if (input.standing) {
    // Run under a standing trade rule: no per-trade intent, the rule is the approval.
    const t = input.standing;
    const verdict = evaluateTradeRule(status, t);
    if (!verdict.covered) {
      throw new Error(
        `No standing rule covers this swap: ${verdict.reason}. Nothing was sent. ` +
          `The owner would need to approve it, so propose it again.`,
      );
    }
    const r = verdict.rule;
    intent = {
      intentId: STANDING_RULE_LABEL,
      inType: t.inType,
      outType: t.outType,
      inSymbol: r.inSymbol,
      outSymbol: r.outSymbol,
      inDecimals: r.inDecimals,
      outDecimals: r.outDecimals,
      amountIn: t.amountIn,
      minOut: t.minOut,
      expiryMs: r.expiryMs,
    };
  } else {
    const found = status.intents.find((i) => i.intentId === input.intentId);
    if (!found) {
      throw new Error(
        `No open approved trade ${input.intentId}. It was never approved, was already executed, or was cancelled.`,
      );
    }
    if (Date.now() > found.expiryMs) {
      throw new Error(`The approval for ${found.intentId} expired at ${new Date(found.expiryMs).toISOString()}.`);
    }
    intent = found;
  }
  const have = sleeveBalance(status, intent.inType);
  if (have < intent.amountIn) {
    throw new Error(`The trading sleeve holds less than the ${intent.amountIn} (raw) this trade sells.`);
  }

  const dex = getDex();
  const expected = await dex.quote(input.client, intent.inType, intent.outType, intent.amountIn);
  if (expected < intent.minOut) {
    throw new Error(
      `The market moved. ${dex.name} now returns ${formatAmount(expected, { decimals: intent.outDecimals, symbol: intent.outSymbol })}, ` +
        `below the approved minimum of ${formatAmount(intent.minOut, { decimals: intent.outDecimals, symbol: intent.outSymbol })}. ` +
        `The swap would fail, so nothing was sent. Propose a new trade at the current price.`,
    );
  }

  const tx = new Transaction();
  tx.setSender(sender);
  const typeArguments = [intent.inType, intent.outType];
  const [coinIn, ticket] = input.standing
    ? tx.moveCall({
        target: `${config.packageId}::spending_vault::begin_swap_auto`,
        typeArguments,
        arguments: [
          tx.object(config.agentCapId),
          tx.object(config.vaultId),
          tx.pure.u64(intent.amountIn),
          tx.pure.u64(intent.minOut),
          tx.object.clock(),
        ],
      })
    : tx.moveCall({
        target: `${config.packageId}::spending_vault::begin_swap`,
        typeArguments,
        arguments: [tx.object(config.agentCapId), tx.object(config.vaultId), tx.pure.id(intent.intentId), tx.object.clock()],
      });
  const coinOut = dex.addSwap(tx, coinIn!, intent.inType, intent.outType);
  tx.moveCall({
    target: `${config.packageId}::spending_vault::finish_swap`,
    typeArguments,
    arguments: [ticket!, tx.object(config.vaultId), coinOut],
  });
  return { tx, sender, intent, expected, dexName: dex.name };
}

export interface SwapDryRunResult {
  sender: string;
  intent: IntentInfo;
  expectedOut: bigint;
  success: boolean;
  error: string | null;
  gasMist: bigint | null;
}

/** Simulates the swap on the node. Nothing is signed or submitted. */
export async function dryRunSwap(input: SwapInput): Promise<SwapDryRunResult> {
  const { tx, sender, intent, expected } = await prepareSwap(input);
  const result = await input.client.simulateTransaction({ transaction: tx, include: { effects: true } });
  const outcome = result.$kind === "FailedTransaction" ? result.FailedTransaction : result.Transaction;
  const gas = outcome.effects?.gasUsed ?? null;
  return {
    sender,
    intent,
    expectedOut: expected,
    success: result.$kind === "Transaction",
    error: result.$kind === "FailedTransaction" ? (outcome.status.error?.message ?? "Simulation failed.") : null,
    gasMist: gas ? netGasMist(gas) : null,
  };
}

export function formatSwapDryRun(r: SwapDryRunResult): string {
  const inAmt = formatAmount(r.intent.amountIn, { decimals: r.intent.inDecimals, symbol: r.intent.inSymbol });
  const outCoin = { decimals: r.intent.outDecimals, symbol: r.intent.outSymbol };
  const lines = [
    `DRY RUN (nothing was signed or submitted)`,
    `Status: ${r.success ? "would succeed" : `would FAIL: ${r.error}`}`,
    `Agent wallet: ${r.sender}`,
    `Sells ${inAmt} from the vault's trading sleeve for about ${formatAmount(r.expectedOut, outCoin)} (approved minimum ${formatAmount(r.intent.minOut, outCoin)})`,
    `The proceeds are deposited back into the vault, never to the agent wallet.`,
  ];
  if (r.gasMist !== null) lines.push(`Estimated gas (paid by the agent wallet): ${formatAmount(r.gasMist, { decimals: 9, symbol: "SUI" })}`);
  return lines.join("\n");
}

export interface SwapReceipt {
  digest: string;
  sender: string;
  intent: IntentInfo;
  amountOut: bigint;
  gasMist: bigint | null;
  explorerUrl: string;
}

/** Executes an approved intent. The agent wallet only pays gas. */
export async function vaultSwap(input: SwapInput & { signer: Ed25519Keypair }): Promise<SwapReceipt> {
  const { tx, sender, intent } = await prepareSwap({ ...input, sender: input.signer.toSuiAddress() });
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
  const swapped = executed.events?.find((event) => event.eventType.includes("::spending_vault::Swapped"));
  const amountOut = swapped?.json?.amount_out;
  return {
    digest: executed.digest,
    sender,
    intent,
    amountOut: typeof amountOut === "string" ? BigInt(amountOut) : 0n,
    gasMist: gas ? netGasMist(gas) : null,
    explorerUrl: explorerTxUrl(input.network, executed.digest),
  };
}

export function formatSwapReceipt(r: SwapReceipt): string {
  const outCoin = { decimals: r.intent.outDecimals, symbol: r.intent.outSymbol };
  const lines = [
    `Swapped ${formatAmount(r.intent.amountIn, { decimals: r.intent.inDecimals, symbol: r.intent.inSymbol })} for ${formatAmount(r.amountOut, outCoin)}`,
    `Minimum the contract required was ${formatAmount(r.intent.minOut, outCoin)}${r.intent.intentId === STANDING_RULE_LABEL ? " (ran under a standing trade rule)" : ""}. Proceeds are in the vault's trading sleeve.`,
    `Signed by agent wallet: ${r.sender}`,
    `Digest: ${r.digest}`,
    `Explorer: ${r.explorerUrl}`,
  ];
  if (r.gasMist !== null) lines.push(`Gas (paid by the agent wallet): ${formatAmount(r.gasMist, { decimals: 9, symbol: "SUI" })}`);
  return lines.join("\n");
}

/**
 * Runs the trade the owner approved for a proposal, and records the outcome on it.
 * Refuses unless the proposal was approved (the on-chain intent is the real check).
 */
export async function executeProposal(
  input: { client: SuiGrpcClient; network: SuiNetwork; signer: Ed25519Keypair; proposalId: string; dryRun?: boolean },
): Promise<{ proposal: Proposal; text: string }> {
  const proposal = await requireProposal(input.proposalId);
  if (!isSwapProposal(proposal)) {
    throw new Error(`Proposal ${proposal.id} is a payment, not a swap. Run it with vault_spend_approved.`);
  }
  if (proposal.status === "executed") {
    return { proposal, text: `Already executed.\n${describeProposal(proposal)}` };
  }
  if (proposal.status !== "approved" || (!proposal.auto && !proposal.intentId)) {
    throw new Error(
      `Proposal ${proposal.id} is ${proposal.status}, not approved. ` +
        (proposal.status === "pending"
          ? "The owner has not approved it yet. Do not retry; wait for them to approve it in the UI."
          : "It cannot be executed."),
    );
  }
  const base = { client: input.client, network: input.network, signer: input.signer, sender: input.signer.toSuiAddress() };
  const swapInput = proposal.auto
    ? {
        ...base,
        standing: {
          inType: proposal.inType,
          outType: proposal.outType,
          amountIn: BigInt(proposal.amountIn),
          minOut: BigInt(proposal.minOut),
        },
      }
    : { ...base, intentId: proposal.intentId! };
  if (input.dryRun) return { proposal, text: formatSwapDryRun(await dryRunSwap(swapInput)) };
  try {
    const receipt = await vaultSwap({ ...swapInput, signer: input.signer });
    const updated = await updateProposal(proposal.id, {
      status: "executed",
      swapDigest: receipt.digest,
      amountOut: receipt.amountOut.toString(),
    });
    return { proposal: updated, text: formatSwapReceipt(receipt) };
  } catch (error) {
    // Keep the status: a pre-check failure (e.g. the market moved) may be retryable until
    // the on-chain approval expires. The message is kept for the UI.
    const message = error instanceof Error ? error.message : String(error);
    await updateProposal(proposal.id, { error: message });
    throw error;
  }
}
