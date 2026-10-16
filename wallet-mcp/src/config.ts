import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isSuiNetwork, type SuiNetwork } from "./blockchain/client.js";

/** Directory that contains package.json, whether this file is run from src/ or build/. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_NETWORK: SuiNetwork = "testnet";

export function packageRoot(): string {
  return PACKAGE_ROOT;
}

/**
 * This milestone only signs on testnet. A read-only balance query may use
 * another network; anything that touches a key must call this first.
 */
export function assertTestnet(network: SuiNetwork): void {
  if (network !== "testnet") {
    throw new Error(
      `Refusing to sign on "${network}". This wallet only spends testnet SUI.`,
    );
  }
}

export function resolveNetwork(value = process.env.SUI_NETWORK): SuiNetwork {
  if (!value) return DEFAULT_NETWORK;
  if (!isSuiNetwork(value)) {
    throw new Error(`Unknown network "${value}". Use testnet, mainnet, devnet, or localnet.`);
  }
  return value;
}

export type WalletRole = "sender" | "receiver";

/** Local key file. Overridden by SUI_WALLET_FILE for the sender only. */
export function walletPath(role: WalletRole = "sender"): string {
  if (role === "sender" && process.env.SUI_WALLET_FILE) return process.env.SUI_WALLET_FILE;
  return join(PACKAGE_ROOT, ".wallet", `${role}.json`);
}

export function explorerTxUrl(network: SuiNetwork, digest: string): string {
  return `https://suiscan.xyz/${network}/tx/${digest}`;
}

export function explorerAddressUrl(network: SuiNetwork, address: string): string {
  return `https://suiscan.xyz/${network}/account/${address}`;
}
