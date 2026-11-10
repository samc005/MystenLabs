import type { McpServer } from "@modelcontextprotocol/server";
import { Transaction } from "@mysten/sui/transactions";
import { parseToMist } from "@mysten/sui/utils";
import { z } from "zod";
import { createSuiClient } from "../../blockchain/client.js";
import { fundFromFaucet, waitForFaucet } from "../../blockchain/faucet.js";
import { executeWalletTransaction, writeReceipt } from "../../blockchain/writes.js";
import { requireAddress, requireWallet } from "../../blockchain/wallet.js";
import { resolveNetwork } from "../../config.js";

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function positiveMist(value: string): bigint {
  try {
    const amount = parseToMist(value);
    if (amount <= 0n) throw new Error();
    return amount;
  } catch {
    throw new Error(`Amount must be a positive SUI decimal string, for example "0.01". Got "${value}".`);
  }
}

export function registerWriteTools(server: McpServer): void {
  server.registerTool(
    "request_faucet",
    {
      description:
        "Request testnet SUI for the local wallet from the Sui faucet. This mutates the testnet balance and may take a few minutes due to proof of work.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const network = resolveNetwork();
        const wallet = await requireWallet(network);
        const faucet = await fundFromFaucet(network, wallet.address);
        await waitForFaucet(createSuiClient(network), faucet.digest);
        return {
          content: [{
            type: "text",
            text: writeReceipt(network, faucet.digest, `Faucet credited ${faucet.amountMist} MIST to ${wallet.address}.`),
          }],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "wait_for_transaction",
    {
      description: "Wait for a Sui transaction digest to reach a checkpoint and report its final result.",
      inputSchema: z.object({
        digest: z.string().min(1).describe("Sui transaction digest."),
        timeoutMs: z.number().int().min(1_000).max(120_000).optional().default(60_000),
      }),
    },
    async ({ digest, timeoutMs }) => {
      try {
        const network = resolveNetwork();
        const result = await createSuiClient(network).waitForTransaction({
          digest,
          timeout: timeoutMs,
          include: { effects: true, balanceChanges: true, events: true },
        });
        if (result.$kind === "FailedTransaction") {
          throw new Error(result.FailedTransaction.status.error?.message ?? "Transaction failed.");
        }
        return { content: [{ type: "text", text: writeReceipt(network, result.Transaction.digest, "Transaction confirmed.") }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "split_coin",
    {
      description:
        "Split a local wallet coin object into a new coin of the requested SUI amount. The new coin remains owned by the local wallet unless recipient is provided.",
      inputSchema: z.object({
        coinId: z.string().min(1).describe("SUI coin object ID owned by the local wallet."),
        amount: z.string().describe('Amount to split in SUI, such as "0.01".'),
        recipient: z.string().optional().describe("Optional recipient address for the newly split coin."),
      }),
    },
    async ({ coinId, amount, recipient }) => {
      try {
        const network = resolveNetwork();
        const wallet = await requireWallet(network);
        const tx = new Transaction();
        tx.setSender(wallet.address);
        const [split] = tx.splitCoins(tx.object(coinId), [tx.pure.u64(positiveMist(amount))]);
        tx.transferObjects([split], requireAddress(recipient ?? wallet.address));
        const digest = await executeWalletTransaction({
          client: createSuiClient(network),
          network,
          signer: wallet.keypair,
          transaction: tx,
        });
        return { content: [{ type: "text", text: writeReceipt(network, digest, `Split ${amount} SUI from ${coinId}.`) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "merge_coins",
    {
      description: "Merge local wallet SUI coin objects into a primary coin object.",
      inputSchema: z.object({
        primaryCoinId: z.string().min(1).describe("Coin object that receives the balance."),
        coinIds: z.array(z.string().min(1)).min(1).max(50).describe("Other SUI coin objects to merge."),
      }),
    },
    async ({ primaryCoinId, coinIds }) => {
      try {
        const network = resolveNetwork();
        const wallet = await requireWallet(network);
        if (coinIds.includes(primaryCoinId)) throw new Error("primaryCoinId must not also appear in coinIds.");
        const tx = new Transaction();
        tx.setSender(wallet.address);
        tx.mergeCoins(tx.object(primaryCoinId), coinIds.map((coinId) => tx.object(coinId)));
        const digest = await executeWalletTransaction({
          client: createSuiClient(network),
          network,
          signer: wallet.keypair,
          transaction: tx,
        });
        return { content: [{ type: "text", text: writeReceipt(network, digest, `Merged ${coinIds.length} coin(s) into ${primaryCoinId}.`) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
