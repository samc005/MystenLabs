import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer({ name: "hello", version: "1.0.0" });

server.registerTool(
  "ping",
  {
    description:
      "Greet someone by name. Use this to check that the MCP server is working.",
    inputSchema: z.object({
      name: z.string().describe("The name of the person to greet"),
    }),
  },
  async ({ name }) => ({
    content: [{ type: "text", text: `Hello, ${name}! The MCP server is working.` }],
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Hello MCP server running on stdio"); // stderr, not stdout
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});