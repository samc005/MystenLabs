import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./mcp/server.js";

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("wallet-mcp running on stdio");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
