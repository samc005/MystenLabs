import type { McpServer } from "@modelcontextprotocol/server";
import { requireWallet } from "../../blockchain/wallet.js";
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
        const wallet = await requireWallet(network);
        return {
          content: [{ type: "text", text: `Network: ${network}\nAddress: ${wallet.address}` }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );
}
