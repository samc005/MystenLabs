import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createSuiClient } from "../../blockchain/client.js";
import { resolveNetwork } from "../../config.js";
import { formatJson } from "./toolUtils.js";

export function registerGetTransaction(server: McpServer): void {
  server.registerTool(
    "get_transaction",
    {
      description: "Read the status, effects, events, and balance changes for a Sui transaction.",
      inputSchema: z.object({
        digest: z.string().min(1).describe("Sui transaction digest."),
      }),
    },
    async ({ digest }) => {
      try {
        const network = resolveNetwork();
        const result = await createSuiClient(network).getTransaction({
          digest,
          include: { effects: true, balanceChanges: true, events: true, transaction: true },
        });
        return {
          content: [{ type: "text", text: `Network: ${network}\n${formatJson(result)}` }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );
}
