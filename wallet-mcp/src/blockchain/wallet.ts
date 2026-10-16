import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import { assertTestnet, walletPath, type WalletRole } from "../config.js";
import type { SuiNetwork } from "./client.js";

export interface StoredWallet {
  network: SuiNetwork;
  address: string;
  secretKey: string;
}

export interface LoadedWallet {
  keypair: Ed25519Keypair;
  address: string;
  filePath: string;
  created: boolean;
}

function parseStoredWallet(raw: string, filePath: string): StoredWallet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Wallet file is not valid JSON: ${filePath}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("address" in parsed) ||
    !("secretKey" in parsed) ||
    !("network" in parsed)
  ) {
    throw new Error(`Wallet file is missing address, secretKey, or network: ${filePath}`);
  }
  const wallet = parsed as StoredWallet;
  if (typeof wallet.secretKey !== "string" || typeof wallet.address !== "string") {
    throw new Error(`Wallet file has the wrong shape: ${filePath}`);
  }
  return wallet;
}

async function readWallet(filePath: string): Promise<StoredWallet | undefined> {
  try {
    return parseStoredWallet(await readFile(filePath, "utf8"), filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Loads the local testnet key. Returns undefined when no wallet file exists.
 * SUI_SECRET_KEY, when set, overrides the sender file and is not written to disk.
 */
export async function loadWallet(
  network: SuiNetwork,
  role: WalletRole = "sender",
): Promise<LoadedWallet | undefined> {
  assertTestnet(network);
  const filePath = walletPath(role);
  const envKey = role === "sender" ? process.env.SUI_SECRET_KEY : undefined;

  if (envKey) {
    const keypair = Ed25519Keypair.fromSecretKey(envKey);
    return { keypair, address: keypair.toSuiAddress(), filePath, created: false };
  }

  const existing = await readWallet(filePath);
  if (!existing) return undefined;
  if (existing.network !== network) {
    throw new Error(
      `Wallet file ${filePath} is for ${existing.network}, but the active network is ${network}.`,
    );
  }
  const keypair = Ed25519Keypair.fromSecretKey(existing.secretKey);
  const address = keypair.toSuiAddress();
  if (normalizeSuiAddress(existing.address) !== address) {
    throw new Error(`Address in ${filePath} does not match its secret key.`);
  }
  return { keypair, address, filePath, created: false };
}

export async function requireWallet(
  network: SuiNetwork,
  role: WalletRole = "sender",
): Promise<LoadedWallet> {
  const wallet = await loadWallet(network, role);
  if (!wallet) {
    throw new Error("No local testnet wallet yet. From wallet-mcp, run: npm run setup");
  }
  return wallet;
}

/** Loads the local testnet key, or creates one and writes it with mode 0600. */
export async function loadOrCreateWallet(
  network: SuiNetwork,
  role: WalletRole = "sender",
): Promise<LoadedWallet> {
  const existing = await loadWallet(network, role);
  if (existing) return existing;

  const filePath = walletPath(role);
  const keypair = new Ed25519Keypair();
  const stored: StoredWallet = {
    network,
    address: keypair.toSuiAddress(),
    secretKey: keypair.getSecretKey(),
  };
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  return { keypair, address: stored.address, filePath, created: true };
}

export function requireAddress(value: string): string {
  const normalized = normalizeSuiAddress(value);
  if (!isValidSuiAddress(normalized)) {
    throw new Error(`Not a valid Sui address: ${value}`);
  }
  return normalized;
}
