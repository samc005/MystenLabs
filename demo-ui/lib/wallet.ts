// Browser counterpart of wallet-mcp/src/blockchain/wallet.ts. Testnet keys live
// in this browser's localStorage instead of .wallet/*.json. Testnet only.

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { NETWORK } from "./sui";

export type WalletRole = "sender" | "receiver";

interface StoredWallet {
  network: typeof NETWORK;
  address: string;
  secretKey: string;
}

export interface DemoWallet {
  role: WalletRole;
  keypair: Ed25519Keypair;
  address: string;
}

const storageKey = (role: WalletRole) => `sui-demo-wallet:${NETWORK}:${role}`;

function read(role: WalletRole): StoredWallet | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey(role));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as StoredWallet;
    if (parsed.network !== NETWORK || typeof parsed.secretKey !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function write(role: WalletRole, wallet: StoredWallet): void {
  try {
    window.localStorage.setItem(storageKey(role), JSON.stringify(wallet));
  } catch {
    // Storage blocked (private window). The wallet still works until the tab closes.
  }
}

/** Loads this browser's testnet wallet for `role`, or creates and stores a new one. */
export function loadOrCreateWallet(role: WalletRole): DemoWallet {
  const existing = read(role);
  if (existing) {
    const keypair = Ed25519Keypair.fromSecretKey(existing.secretKey);
    if (keypair.toSuiAddress() === existing.address) {
      return { role, keypair, address: existing.address };
    }
  }
  const keypair = new Ed25519Keypair();
  const address = keypair.toSuiAddress();
  write(role, { network: NETWORK, address, secretKey: keypair.getSecretKey() });
  return { role, keypair, address };
}

/** Forgets the stored key and creates a fresh wallet. Any testnet SUI on the old one is abandoned. */
export function resetWallet(role: WalletRole): DemoWallet {
  try {
    window.localStorage.removeItem(storageKey(role));
  } catch {
    // Nothing stored.
  }
  return loadOrCreateWallet(role);
}
