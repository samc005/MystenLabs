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

export function registerTools(server: McpServer): void {
  registerGetAddress(server);
  registerGetBalance(server);
  registerGetTransaction(server);
  registerListTransactions(server);
  registerGetCoinMetadata(server);
  registerListOwnedObjects(server);
  registerGetNft(server);
  registerEstimateGas(server);
  registerTransfer(server);
}
