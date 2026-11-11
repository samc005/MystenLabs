import { explorerTxUrl } from "../config.js";
import type { SuiNetwork } from "./client.js";

export function writeReceipt(network: SuiNetwork, digest: string, summary: string): string {
  return `${summary}\nDigest: ${digest}\nExplorer: ${explorerTxUrl(network, digest)}`;
}
