import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createSuiClient } from "../../blockchain/client.js";
import { formatAmount, parseUnits } from "../../blockchain/coins.js";
import { prepareSpendProposal, proposeSpend } from "../../blockchain/payments.js";
import { describeProposal, isSwapProposal, getProposal, isProposalId, listProposals } from "../../blockchain/proposals.js";
import {
  dryRunSwap,
  prepareSwap,
  formatQuote,
  formatSwapDryRun,
  MAX_SLIPPAGE_BPS,
  proposeTrade,
  quoteSwap,
} from "../../blockchain/swap.js";
import { formatValidators, listValidators } from "../../blockchain/validators.js";
import { getVaultStatus } from "../../blockchain/vault.js";
import { configuredAddress } from "../../blockchain/address.js";
import { unsignedTransactionResult } from "./approvedTransaction.js";
import { resolveNetwork } from "../../config.js";

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

/**
 * Trading tools. None of them can approve a trade or touch the owner key: the agent can
 * quote, propose, and run a trade the owner has already approved on-chain.
 */
export function registerTrading(server: McpServer): void {
  server.registerTool(
    "swap_quote",
    {
      description:
        'Read-only price check: what you would get for selling an amount of one coin for another right now, on the testnet pool. Coins: "SUI" or "tUSDC". Amount is a decimal string in the sold coin, e.g. "1.5". Does not propose or trade anything.',
      inputSchema: z.object({
        sell: z.string().describe('Coin to sell: "SUI" or "tUSDC".'),
        buy: z.string().describe('Coin to buy: "SUI" or "tUSDC".'),
        amount: z.string().describe('Amount of the sold coin, as a decimal string such as "1".'),
      }),
    },
    async ({ sell, buy, amount }) => {
      try {
        const client = createSuiClient(resolveNetwork());
        return text(formatQuote(await quoteSwap(client, sell, buy, amount)));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "propose_trade",
    {
      description:
        "Propose a swap for the vault owner to approve. THIS DOES NOT TRADE. It quotes the swap, records the exact terms, and shows the owner an approval card in the app. " +
        "Only the owner can approve (by signing on-chain); you cannot. After calling this, tell the owner the proposal is waiting for their approval and STOP. " +
        "Exception: if the owner has set a standing trade rule that covers this swap (vault_status lists the rules), the result says so and no approval is needed: call vault_swap with the proposalId. " +
        "Only call vault_swap after the owner tells you they approved it. The swap sells only funds the owner put in the trading sleeve (see vault_status). " +
        `Slippage is how much worse than the quote the owner will accept, in basis points (default 100 = 1%, max ${MAX_SLIPPAGE_BPS}). The terms come from the live quote, not from you.`,
      inputSchema: z.object({
        sell: z.string().describe('Coin to sell: "SUI" or "tUSDC".'),
        buy: z.string().describe('Coin to buy: "SUI" or "tUSDC".'),
        amount: z.string().describe('Amount of the sold coin, as a decimal string such as "1".'),
        slippageBps: z
          .number()
          .int()
          .optional()
          .describe(`Max slippage in basis points, 1 to ${MAX_SLIPPAGE_BPS}. Default 100.`),
      }),
    },
    async ({ sell, buy, amount, slippageBps }) => {
      try {
        const client = createSuiClient(resolveNetwork());
        const proposal = await proposeTrade(client, { sell, buy, amount, slippageBps });
        if (proposal.auto) {
          return text(
            `${describeProposal(proposal)}\n\n` +
              `Nothing has been traded yet, but the owner's standing trade rule already covers this swap, so no approval is needed. ` +
              `Call vault_swap with this proposalId to run it. The contract re-checks the rule and rejects the swap if it is outside it.`,
          );
        }
        return text(
          `${describeProposal(proposal)}\n\n` +
            `Nothing has been traded. The owner must approve this proposal in the app (an approval card is shown). ` +
            `Wait for them to say they approved it before calling vault_swap.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "propose_spend",
    {
      description:
        "Ask the vault owner to approve a payment that the spending policy does not allow directly: over the per-spend limit, over this epoch's spending cap, or to a recipient not on the allowlist. " +
        "THIS DOES NOT PAY. It records the exact recipient and amount and shows the owner an approval card; only the owner can approve (by signing on-chain). " +
        "After calling this, tell the owner it is waiting for their approval and STOP. Only call vault_spend_approved after the owner says they approved it. " +
        "If vault_spend would work (the payment is within the policy), use that instead; this tool refuses payments that need no approval.",
      inputSchema: z.object({
        recipient: z.string().describe("Sui address (0x...) to pay."),
        amount: z.string().describe('Amount of SUI as a decimal string, e.g. "2.5".'),
      }),
    },
    async ({ recipient, amount }) => {
      try {
        const network = resolveNetwork();
        const client = createSuiClient(network);
        const proposal = await proposeSpend({ client, network, recipient, amountMist: parseUnits(amount, 9) });
        return text(
          `${describeProposal(proposal)}\n\n` +
            `Nothing has been paid. The owner must approve this in the app (an approval card is shown). ` +
            `Wait for them to say they approved it before calling vault_spend_approved.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "vault_spend_approved",
    {
      description:
        "Execute a payment the owner approved. Pass the proposalId of an approved spend proposal. " +
        "The contract only pays the exact recipient and amount the owner approved on-chain, exactly once, before the approval expires. " +
        "If the proposal is still pending, do not call this: wait for the owner. Set dryRun to true to simulate without sending.",
      inputSchema: z.object({
        proposalId: z.string().describe("ID of an approved spend proposal, like prop_1a2b3c4d5e."),
        dryRun: z.boolean().optional().describe("If true, simulate only. Nothing is signed or submitted."),
      }),
    },
    async ({ proposalId, dryRun }) => {
      try {
        if (!isProposalId(proposalId)) throw new Error(`"${proposalId}" is not a proposal ID.`);
        const network = resolveNetwork();
        const client = createSuiClient(network);
        const { tx } = await prepareSpendProposal({
          client, network, sender: configuredAddress(network), proposalId,
        });
        if (dryRun) {
          const result = await client.simulateTransaction({ transaction: tx });
          return text(result.$kind === "Transaction" ? "Simulation succeeded; nothing signed." : "Simulation failed; nothing signed.");
        }
        return await unsignedTransactionResult(client, tx);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_proposal",
    {
      description:
        "Check the status of a trade or payment proposal (pending, approved, executed, rejected, expired) or list recent proposals if no ID is given.",
      inputSchema: z.object({
        proposalId: z.string().optional().describe("Proposal ID like prop_1a2b3c4d5e. Omit to list recent ones."),
      }),
    },
    async ({ proposalId }) => {
      try {
        if (!proposalId) {
          const proposals = await listProposals(10);
          return text(proposals.length ? proposals.map(describeProposal).join("\n\n") : "No proposals yet.");
        }
        if (!isProposalId(proposalId)) throw new Error(`"${proposalId}" is not a proposal ID.`);
        const proposal = await getProposal(proposalId);
        if (!proposal) throw new Error(`No proposal ${proposalId}.`);
        return text(describeProposal(proposal));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "vault_intents",
    {
      description:
        "List what the owner has approved on-chain that has not run yet: single trades, and one-off payments. Standing trade rules are listed by vault_status.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const status = await getVaultStatus(createSuiClient(resolveNetwork()));
        const lines = [
          ...status.intents.map(
            (i) =>
              `Trade ${i.intentId}: sell ${formatAmount(i.amountIn, { decimals: i.inDecimals, symbol: i.inSymbol })} for at least ${formatAmount(i.minOut, { decimals: i.outDecimals, symbol: i.outSymbol })}, approval expires ${new Date(i.expiryMs).toISOString()}`,
          ),
          ...status.spendIntents.map(
            (i) =>
              `Payment ${i.intentId}: ${formatAmount(i.amountMist, { decimals: 9, symbol: "SUI" })} to ${i.recipient}, approval expires ${new Date(i.expiryMs).toISOString()}`,
          ),
        ];
        if (lines.length === 0) return text("No approved trades or payments are waiting.");
        return text(lines.join("\n"));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "vault_swap",
    {
      description:
        "Prepare an unsigned trade the owner has approved. Execution requires execute_approved_transaction with trusted policy approval. Pass the proposalId of an approved proposal (or an intentId from vault_intents). " +
        "The contract only allows it if the owner approved it on-chain, exactly once, before it expires, at no worse than the approved minimum; otherwise it is rejected. " +
        "The proceeds go back into the vault, not the agent wallet. If the proposal is still pending, do not call this: wait for the owner. Set dryRun to true to simulate without sending.",
      inputSchema: z.object({
        proposalId: z.string().optional().describe("ID of an approved proposal, like prop_1a2b3c4d5e."),
        intentId: z.string().optional().describe("On-chain intent ID (0x...), instead of a proposalId."),
        dryRun: z.boolean().optional().describe("If true, simulate only. Nothing is signed or submitted."),
      }),
    },
    async ({ proposalId, intentId, dryRun }) => {
      try {
        if (!proposalId && !intentId) throw new Error("Provide a proposalId or an intentId.");
        const network = resolveNetwork();
        const sender = configuredAddress(network);
        const client = createSuiClient(network);
        if (proposalId) {
          const proposal = await getProposal(proposalId);
          if (!proposal || !isSwapProposal(proposal) || proposal.status !== "approved" || (!proposal.auto && !proposal.intentId)) {
            throw new Error("Proposal must be approved on-chain before preparing a swap.");
          }
          if (proposal.auto) {
            const input = { client, network, sender, standing: {
              inType: proposal.inType, outType: proposal.outType,
              amountIn: BigInt(proposal.amountIn), minOut: BigInt(proposal.minOut),
            } };
            if (dryRun) return text(formatSwapDryRun(await dryRunSwap(input)));
            const { tx } = await prepareSwap(input);
            return await unsignedTransactionResult(client, tx);
          }
          intentId = proposal.intentId;
        }
        const input = { client, network, sender, intentId: intentId! };
        if (dryRun) return text(formatSwapDryRun(await dryRunSwap(input)));
        const { tx } = await prepareSwap(input);
        return await unsignedTransactionResult(client, tx);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_validators",
    {
      description:
        "Read-only: the network's active validators with their address, commission, total stake, and voting power, and which ones the vault owner has already allowed for staking. Use this to find a validator address to suggest; only an allowed validator can be used with vault_stake.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).optional().describe("How many to show (default 15)."),
      }),
    },
    async ({ limit }) => {
      try {
        const network = resolveNetwork();
        const [{ epoch, validators }, status] = await Promise.all([
          listValidators(network),
          getVaultStatus(createSuiClient(network)),
        ]);
        return text(formatValidators(epoch, validators, status.allowedValidators, limit));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
