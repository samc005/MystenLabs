import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createSuiClient } from "../../blockchain/client.js";
import { resolveNetwork } from "../../config.js";
import { formatJson } from "./toolUtils.js";

export function registerGetCoinMetadata(server: McpServer): void {
  server.registerTool(
    "get_coin_metadata",
    {
      description: "Read metadata such as symbol, decimals, name, and icon URL for a Sui coin type.",
      inputSchema: z.object({
        coinType: z.string().min(1).describe("Fully qualified Sui coin type."),
      }),
    },
    async ({ coinType }) => {
      try {
        const network = resolveNetwork();
        const result = await createSuiClient(network).getCoinMetadata({ coinType });
        if (!result.coinMetadata) throw new Error(`No metadata found for coin type: ${coinType}`);
        return {
          content: [{ type: "text", text: `Network: ${network}\n${formatJson(result.coinMetadata)}` }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );
}
