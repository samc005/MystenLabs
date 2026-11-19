// Public configuration and live balances for the wallet panel.

import { existsSync } from "node:fs";
import path from "node:path";
import { createSuiClient, getSuiBalance } from "@/lib/sui";
import type { AccountContext } from "./account-context";

/** owner: your wallet, signs limits. agent: Cipher's key, pays gas. vault: the money Cipher may spend. */
export type WalletRole = "owner" | "agent" | "vault";

export interface LocalWallet {
  role: WalletRole;
  /** An address for owner and agent, an object ID for the vault. */
  address: string;
  kind: "address" | "object";
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

async function vaultBalanceMist(client: ReturnType<typeof createSuiClient>, vaultId: string): Promise<string | null> {
  try {
    const { object } = await client.getObject({ objectId: vaultId, include: { json: true } });
    const balance = (object.json as { balance?: unknown } | null | undefined)?.balance;
    return typeof balance === "string" && /^\d+$/.test(balance) ? balance : null;
  } catch {
    return null;
  }
}

/** This account's owner wallet, agent wallet and vault, with live testnet balances. */
export async function listAccountWallets(account: AccountContext): Promise<LocalWallet[]> {
  const client = createSuiClient();
  const addressBalance = async (address: string): Promise<string | null> => {
    try {
      return (await getSuiBalance(client, address)).toString();
    } catch {
      return null; // Leave the balance unknown; the address is still useful.
    }
  };
  const [owner, agent, vault] = await Promise.all([
    addressBalance(account.ownerAddress),
    addressBalance(account.agentAddress),
    vaultBalanceMist(client, account.vaultId),
  ]);
  return [
    { role: "vault", address: account.vaultId, kind: "object", network: "testnet", balanceMist: vault },
    { role: "owner", address: account.ownerAddress, kind: "address", network: "testnet", balanceMist: owner },
    { role: "agent", address: account.agentAddress, kind: "address", network: "testnet", balanceMist: agent },
  ];
}
