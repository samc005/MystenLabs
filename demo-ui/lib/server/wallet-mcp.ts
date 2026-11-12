// Public configuration and live balances for the wallet panel.

import { existsSync } from "node:fs";
import path from "node:path";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import { createSuiClient, getSuiBalance } from "@/lib/sui";

export const WALLET_ROLES = ["sender", "receiver"] as const;
export type LocalWalletRole = (typeof WALLET_ROLES)[number];

export interface LocalWallet {
  role: LocalWalletRole;
  address: string;
  network: string;
  /** Balance in MIST as a decimal string, or null when it could not be read. */
  balanceMist: string | null;
}

export interface WalletMcpStatus {
  dir: string;
  found: boolean;
  installed: boolean;
  built: boolean;
  apiKey: boolean;
}

export function walletMcpDir(): string {
  return process.env.WALLET_MCP_DIR ?? path.resolve(process.cwd(), "..", "wallet-mcp");
}

export function walletMcpEntry(): string {
  return path.join(walletMcpDir(), "build", "index.js");
}

export function walletMcpStatus(): WalletMcpStatus {
  const dir = walletMcpDir();
  return {
    dir,
    found: existsSync(path.join(dir, "package.json")),
    installed: existsSync(path.join(dir, "node_modules")),
    built: existsSync(walletMcpEntry()),
    apiKey: Boolean(process.env.ANTHROPIC_API_KEY),
  };
}

export function configuredWalletAddress(role: LocalWalletRole): string | undefined {
  const value = role === "sender" ? process.env.SUI_ADDRESS : process.env.SUI_RECEIVER_ADDRESS;
  if (!value) return undefined;
  const address = normalizeSuiAddress(value);
  return isValidSuiAddress(address) ? address : undefined;
}

/** The configured public addresses, with live testnet balances. */
export async function listLocalWallets(): Promise<LocalWallet[]> {
  const client = createSuiClient();
  const found = await Promise.all(
    WALLET_ROLES.map(async (role) => {
      const address = configuredWalletAddress(role);
      if (!address) return undefined;
      let balanceMist: string | null = null;
      try {
        balanceMist = (await getSuiBalance(client, address)).toString();
      } catch {
        // Leave the balance unknown; the address is still useful.
      }
      return { role, address, network: "testnet", balanceMist };
    }),
  );
  return found.filter((wallet): wallet is LocalWallet => wallet !== undefined);
}
