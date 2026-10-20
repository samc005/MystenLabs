import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createSuiClient } from "../../blockchain/client.js";
import { requireAddress } from "../../blockchain/wallet.js";
import { resolveNetwork } from "../../config.js";
import { formatJson, resolveOwner } from "./toolUtils.js";

export function registerListTransactions(server: McpServer): void {
  server.registerTool(
    "list_transactions",
    {
      description: "List recent transactions sent by a Sui address.",
      inputSchema: z.object({
        address: z.string().optional().describe("Sender address. Omit to use the local wallet."),
        limit: z.number().int().min(1).max(50).optional().default(10),
      }),
    },
    async ({ address, limit }) => {
      try {
        const network = resolveNetwork();
        const owner = await resolveOwner(network, address);
        const page = await createSuiClient(network).listTransactions({
          filter: { sender: requireAddress(owner) },
          limit,
          order: "descending",
          include: { effects: true, balanceChanges: true },
        });
        return {
          content: [
            {
              type: "text",
              text: `Network: ${network}\nAddress: ${owner}\n${formatJson(page)}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );
}
