import type { McpServer } from "@modelcontextprotocol/server";
import { registerGetBalance } from "./getBalance.js";
import { registerTransfer } from "./transfer.js";
import { registerVault } from "./vault.js";

export function registerTools(server: McpServer): void {
  registerGetBalance(server);
  registerVault(server);
  // Direct transfers spend from the agent's own wallet and bypass every vault rule
  // (limit, pause, revoke). Off by default; the agent should spend through the vault.
  if (process.env.SUI_ENABLE_DIRECT_TRANSFER === "true") {
    registerTransfer(server);
  }
}
