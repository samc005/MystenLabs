import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createSuiClient } from "../../blockchain/client.js";
import { resolveNetwork } from "../../config.js";
import { formatJson } from "./toolUtils.js";

export function registerGetNft(server: McpServer): void {
  server.registerTool(
    "get_nft",
    {
      description: "Read an owned Sui object's type, display metadata, and JSON content.",
      inputSchema: z.object({
        objectId: z.string().min(1).describe("Sui object ID."),
      }),
    },
    async ({ objectId }) => {
      try {
        const network = resolveNetwork();
        const result = await createSuiClient(network).getObject({
          objectId,
          include: { display: true, json: true, content: true, previousTransaction: true },
        });
        return {
          content: [{ type: "text", text: `Network: ${network}\n${formatJson(result.object)}` }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );
}
