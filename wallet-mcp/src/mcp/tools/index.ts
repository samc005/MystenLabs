import type { McpServer } from "@modelcontextprotocol/server";
import { registerGetBalance } from "./getBalance.js";
import { registerTransfer } from "./transfer.js";

export function registerTools(server: McpServer): void {
  registerGetBalance(server);
  registerTransfer(server);
}
