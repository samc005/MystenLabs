import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createSuiClient } from "../../blockchain/client.js";
import { resolveNetwork } from "../../config.js";
import { formatJson, resolveOwner } from "./toolUtils.js";

export function registerListOwnedObjects(server: McpServer): void {
  server.registerTool(
    "list_owned_objects",
    {
      description: "List objects owned by a Sui address, including object type and display data when available.",
      inputSchema: z.object({
        address: z.string().optional().describe("Owner address. Omit to use the local wallet."),
        type: z.string().optional().describe("Optional exact Move object type filter."),
        limit: z.number().int().min(1).max(50).optional().default(20),
      }),
    },
    async ({ address, type, limit }) => {
      try {
        const network = resolveNetwork();
        const owner = await resolveOwner(network, address);
        const page = await createSuiClient(network).listOwnedObjects({
          owner,
          type,
          limit,
          include: { display: true, json: true, previousTransaction: true },
        });
        return {
          content: [
            {
              type: "text",
              text: `Network: ${network}\nOwner: ${owner}\n${formatJson(page)}`,
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
