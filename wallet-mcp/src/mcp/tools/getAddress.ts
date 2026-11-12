import type { McpServer } from "@modelcontextprotocol/server";
import { configuredAddress } from "../../blockchain/address.js";
import { resolveNetwork } from "../../config.js";

export function registerGetAddress(server: McpServer): void {
  server.registerTool(
    "get_address",
    {
      description: "Return the address of the local wallet for the active network.",
    },
    async () => {
      try {
        const network = resolveNetwork();
        const address = configuredAddress(network);
        return {
          content: [{ type: "text", text: `Network: ${network}\nAddress: ${address}` }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );
}
