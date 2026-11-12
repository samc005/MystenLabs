import type { McpServer } from "@modelcontextprotocol/server";
import { parseToMist } from "@mysten/sui/utils";
import { z } from "zod";
import { createSuiClient } from "../../blockchain/client.js";
import { prepareTransfer } from "../../blockchain/transfer.js";
import { configuredAddress } from "../../blockchain/address.js";
import { unsignedTransactionResult } from "./approvedTransaction.js";
import { resolveNetwork } from "../../config.js";

export function registerTransfer(server: McpServer): void {
  server.registerTool(
    "transfer_sui",
    {
      description:
        "Prepare an unsigned testnet SUI transfer from the configured sender. An approved proposal is required to execute it.",
      inputSchema: z.object({
        to: z.string().describe("Recipient Sui address (0x...)."),
        amount: z.string().describe('Amount of SUI to send, as a decimal string such as "0.01".'),
      }),
    },
    async ({ to, amount }) => {
      try {
        const network = resolveNetwork();
        let amountMist: bigint;
        try {
          amountMist = parseToMist(amount);
        } catch {
          throw new Error(`Amount must be a positive SUI decimal string, for example "0.01". Got "${amount}".`);
        }
        const sender = configuredAddress(network);
        const client = createSuiClient(network);
        const { tx } = await prepareTransfer({
          client,
          network,
          sender,
          recipient: to,
          amountMist,
        });
        return await unsignedTransactionResult(client, tx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );
}
