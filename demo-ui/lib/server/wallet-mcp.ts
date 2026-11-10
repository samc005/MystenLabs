// Read-only view of the sibling wallet-mcp package: where it lives, whether it is
// built, and which local wallets its npm scripts have created. Secret keys are
// never read into a response.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
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

async function readAddress(role: LocalWalletRole): Promise<{ address: string; network: string } | undefined> {
  try {
    const raw = await readFile(path.join(walletMcpDir(), ".wallet", `${role}.json`), "utf8");
    const parsed = JSON.parse(raw) as { address?: unknown; network?: unknown };
    if (typeof parsed.address !== "string") return undefined;
    return { address: parsed.address, network: typeof parsed.network === "string" ? parsed.network : "unknown" };
  } catch {
    return undefined;
  }
}

/** The wallets wallet-mcp's scripts have created, with live testnet balances. */
export async function listLocalWallets(): Promise<LocalWallet[]> {
  const client = createSuiClient();
  const found = await Promise.all(
    WALLET_ROLES.map(async (role) => {
      const stored = await readAddress(role);
      if (!stored) return undefined;
      let balanceMist: string | null = null;
      try {
        balanceMist = (await getSuiBalance(client, stored.address)).toString();
      } catch {
        // Leave the balance unknown; the address is still useful.
      }
      return { role, ...stored, balanceMist };
    }),
  );
  return found.filter((wallet): wallet is LocalWallet => wallet !== undefined);
}
