import type { McpServer } from "@modelcontextprotocol/server";
import { parseToMist } from "@mysten/sui/utils";
import { z } from "zod";
import { createSuiClient } from "../../blockchain/client.js";
import { formatTransferReceipt, transferSui } from "../../blockchain/transfer.js";
import { requireWallet } from "../../blockchain/wallet.js";
import { resolveNetwork } from "../../config.js";

export function registerTransfer(server: McpServer): void {
  server.registerTool(
    "transfer_sui",
    {
      description:
        "Send testnet SUI from the local wallet to a recipient address. Amount is a decimal string in SUI, such as \"0.01\". This submits a real testnet transaction and cannot be reversed. The secret key is never an argument; it stays in the local wallet file. Gas is paid automatically from the sender balance.",
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
        const wallet = await requireWallet(network);
        const client = createSuiClient(network);
        const receipt = await transferSui({
          client,
          network,
          signer: wallet.keypair,
          recipient: to,
          amountMist,
        });
        return { content: [{ type: "text", text: formatTransferReceipt(receipt) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );
}
