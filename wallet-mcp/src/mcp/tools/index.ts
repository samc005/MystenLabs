import type { McpServer } from "@modelcontextprotocol/server";
import { registerEstimateGas } from "./estimateGas.js";
import { registerGetAddress } from "./getAddress.js";
import { registerGetBalance } from "./getBalance.js";
import { registerGetCoinMetadata } from "./getCoinMetadata.js";
import { registerGetNft } from "./getNft.js";
import { registerGetTransaction } from "./getTransaction.js";
import { registerListOwnedObjects } from "./listOwnedObjects.js";
import { registerListTransactions } from "./listTransactions.js";
import { registerTransfer } from "./transfer.js";
import { registerExtendedReadOnlyTools } from "./extendedReadOnly.js";
import { registerWriteTools } from "./writeTools.js";
import { registerVault } from "./vault.js";

export function registerTools(server: McpServer): void {
  registerGetAddress(server);
  registerGetBalance(server);
  registerGetTransaction(server);
  registerListTransactions(server);
  registerGetCoinMetadata(server);
  registerListOwnedObjects(server);
  registerGetNft(server);
  registerEstimateGas(server);
  registerExtendedReadOnlyTools(server);
  registerWriteTools(server);
  registerVault(server);
  // Direct transfers spend from the agent's own wallet and bypass every vault rule
  // (limit, pause, revoke). Off by default; the agent should spend through the vault.
  if (process.env.SUI_ENABLE_DIRECT_TRANSFER === "true") {
    registerTransfer(server);
  }
}
