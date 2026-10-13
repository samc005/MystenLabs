import { McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "./tools/index.js";

export function createServer(): McpServer {
  const server = new McpServer({ name: "wallet", version: "1.0.0" });
  registerTools(server);
  return server;
}
