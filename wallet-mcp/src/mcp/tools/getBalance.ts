import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { formatBalanceReport, getAllBalances } from "../../blockchain/balance.js";
import { createSuiClient } from "../../blockchain/client.js";
import { requireAddress, requireWallet } from "../../blockchain/wallet.js";
import { resolveNetwork } from "../../config.js";

export function registerGetBalance(server: McpServer): void {
  server.registerTool(
    "get_balance",
    {
      description:
        "Read token balances for a Sui address from the network. Amounts are human-readable and come from the chain. Omit address to use the local testnet wallet. Use this before a transfer.",
      inputSchema: z.object({
        address: z
          .string()
          .optional()
          .describe("Sui address to look up. Omit to use the local testnet wallet."),
      }),
    },
    async ({ address }) => {
      try {
        const network = resolveNetwork();
        const owner = address ? requireAddress(address) : (await requireWallet(network)).address;
        const client = createSuiClient(network);
        const balances = await getAllBalances(client, owner);
        return { content: [{ type: "text", text: formatBalanceReport(network, owner, balances) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );
}
