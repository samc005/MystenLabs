import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createSuiClient } from "../../blockchain/client.js";
import { formatAmount } from "../../blockchain/coins.js";
import { describeProposal, getProposal, isProposalId, listProposals } from "../../blockchain/proposals.js";
import {
  dryRunSwap,
  executeProposal,
  formatQuote,
  formatSwapDryRun,
  formatSwapReceipt,
  MAX_SLIPPAGE_BPS,
  proposeTrade,
  quoteSwap,
  vaultSwap,
} from "../../blockchain/swap.js";
import { formatValidators, listValidators } from "../../blockchain/validators.js";
import { getVaultStatus } from "../../blockchain/vault.js";
import { requireWallet } from "../../blockchain/wallet.js";
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
    "get_proposal",
    {
      description:
        "Check the status of a trade proposal (pending, approved, executed, rejected, expired) or list recent proposals if no ID is given.",
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
        "List the trades the owner has approved on-chain that have not run yet. The agent can only ever execute these.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const status = await getVaultStatus(createSuiClient(resolveNetwork()));
        if (status.intents.length === 0) return text("No approved trades are waiting.");
        return text(
          status.intents
            .map(
              (i) =>
                `${i.intentId}: sell ${formatAmount(i.amountIn, { decimals: i.inDecimals, symbol: i.inSymbol })} for at least ${formatAmount(i.minOut, { decimals: i.outDecimals, symbol: i.outSymbol })}, approval expires ${new Date(i.expiryMs).toISOString()}`,
            )
            .join("\n"),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "vault_swap",
    {
      description:
        "Execute a trade the owner has approved. Pass the proposalId of an approved proposal (or an intentId from vault_intents). " +
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
        const wallet = await requireWallet(network);
        const client = createSuiClient(network);
        if (proposalId) {
          const { text: body } = await executeProposal({
            client,
            network,
            signer: wallet.keypair,
            proposalId,
            dryRun,
          });
          return text(body);
        }
        const input = { client, network, signer: wallet.keypair, intentId: intentId! };
        if (dryRun) return text(formatSwapDryRun(await dryRunSwap(input)));
        return text(formatSwapReceipt(await vaultSwap(input)));
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
