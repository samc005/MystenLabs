// The owner's signer in the browser, whichever way the owner signs:
//
//   zklogin  The wallet comes from the Google sign-in. A short-lived ephemeral key, made in this tab
//            and committed to the sign-in, signs; the server-held proof turns that into a zkLogin
//            signature. Nothing permanent is stored in the browser.
//   wallet   An existing wallet (Slush or any Sui wallet) connected through the wallet standard.
//            That wallet signs; this app never sees its key.
//   browser  A key in this browser's storage. Accounts created before zkLogin keep working.
//
// Every owner transaction goes through `client.signAndExecuteTransaction({ signer })`, which only
// needs `toSuiAddress()` and `signTransaction()`, so the three kinds are interchangeable.

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Signer, type PublicKey, type SignatureScheme } from "@mysten/sui/cryptography";
import { toBase64 } from "@mysten/sui/utils";
import { ZkLoginPublicIdentifier, ZkLoginSigner, type ZkLoginSignatureInputs } from "@mysten/sui/zklogin";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { loadWallet } from "./wallet";

export type OwnerKind = "zklogin" | "wallet" | "browser";

/** Thrown when the user has to do something (sign in again, connect a wallet) before signing. */
export class OwnerSignerError extends Error {
  constructor(
    readonly code: "zk_expired" | "wallet_missing" | "wallet_mismatch" | "browser_key_missing",
    message: string,
  ) {
    super(message);
  }
}

// ---- zkLogin ----

const EPHEMERAL_KEY = "cipher-zklogin-ephemeral";

function storedEphemeral(): Ed25519Keypair | null {
  try {
    const secret = window.sessionStorage.getItem(EPHEMERAL_KEY);
    return secret ? Ed25519Keypair.fromSecretKey(secret) : null;
  } catch {
    return null;
  }
}

/**
 * Starts Google sign-in and opens a zkLogin wallet session for this tab. The ephemeral private key
 * stays in sessionStorage; only its public key is sent. Falls back to plain sign-in on any error.
 */
export async function startGoogleSignIn(): Promise<void> {
  try {
    const ephemeral = new Ed25519Keypair();
    window.sessionStorage.setItem(EPHEMERAL_KEY, ephemeral.getSecretKey());
    const response = await fetch("/api/auth/google/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ephemeralPublicKey: ephemeral.getPublicKey().toSuiPublicKey() }),
    });
    const body = (await response.json()) as { url?: string };
    if (response.ok && body.url) {
      window.location.assign(body.url);
      return;
    }
  } catch {
    // Storage blocked or the server is down: plain sign-in still works.
  }
  window.location.assign("/api/auth/google/start");
}

async function zkLoginSigner(expectedAddress: string): Promise<Signer> {
  const ephemeral = storedEphemeral();
  const expired = () =>
    new OwnerSignerError("zk_expired", "Your wallet session expired. Sign in with Google again to sign with your wallet.");
  if (!ephemeral) throw expired();
  const publicKey = ephemeral.getPublicKey().toSuiPublicKey();
  const response = await fetch(`/api/auth/zklogin?publicKey=${encodeURIComponent(publicKey)}`, { cache: "no-store" });
  if (!response.ok) throw expired();
  const body = (await response.json()) as { address: string; maxEpoch: number; proof: ZkLoginSignatureInputs };
  if (body.address !== expectedAddress) throw expired();
  return new ZkLoginSigner({
    ephemeralSigner: ephemeral,
    maxEpoch: body.maxEpoch,
    inputs: body.proof,
    legacyAddress: ZkLoginPublicIdentifier.fromProof(body.address, body.proof).legacyAddress,
    address: body.address,
  });
}

// ---- Wallet standard (Slush and other Sui wallets) ----

const CHAIN = "sui:testnet";
const REMEMBERED_WALLET = "cipher-owner-wallet";

type ConnectFeature = { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> };
type SignTransactionFeature = {
  signTransaction(input: {
    transaction: { toJSON(): Promise<string> };
    account: WalletAccount;
    chain: string;
  }): Promise<{ bytes: string; signature: string }>;
};
type SignPersonalMessageFeature = {
  signPersonalMessage(input: { message: Uint8Array; account: WalletAccount; chain?: string }): Promise<{
    bytes: string;
    signature: string;
  }>;
};

function feature<T>(wallet: Wallet, name: string): T | undefined {
  return (wallet.features as Record<string, unknown>)[name] as T | undefined;
}

/** Sui wallets installed in this browser that can connect and sign transactions. */
export function listSuiWallets(): Wallet[] {
  return getWallets()
    .get()
    .filter((wallet) => feature(wallet, "standard:connect") && feature(wallet, "sui:signTransaction"));
}

/** Calls back whenever a wallet extension registers, so the list can refresh. */
export function onWalletsChanged(callback: () => void): () => void {
  return getWallets().on("register", callback);
}

/** Asks the wallet to connect and returns its accounts. Remembers the wallet for next time. */
export async function connectWallet(wallet: Wallet): Promise<readonly WalletAccount[]> {
  const connect = feature<ConnectFeature>(wallet, "standard:connect");
  if (!connect) throw new Error(`${wallet.name} cannot connect.`);
  const { accounts } = await connect.connect();
  try {
    window.localStorage.setItem(REMEMBERED_WALLET, wallet.name);
  } catch {
    // Only a convenience.
  }
  return accounts.length > 0 ? accounts : wallet.accounts;
}

/** Signs a plain message (not a transaction) with a connected wallet account. Used to prove ownership. */
export async function signMessageWithWallet(wallet: Wallet, account: WalletAccount, message: string): Promise<string> {
  const sign = feature<SignPersonalMessageFeature>(wallet, "sui:signPersonalMessage");
  if (!sign) throw new Error(`${wallet.name} cannot sign messages.`);
  const { signature } = await sign.signPersonalMessage({ message: new TextEncoder().encode(message), account, chain: CHAIN });
  return signature;
}

/** A Signer whose signatures come from a connected wallet. The wallet shows its own approval popup. */
class WalletStandardSigner extends Signer {
  constructor(
    private readonly wallet: Wallet,
    private readonly account: WalletAccount,
  ) {
    super();
  }
  override toSuiAddress(): string {
    return this.account.address;
  }
  override async signTransaction(bytes: Uint8Array): Promise<{ bytes: string; signature: string }> {
    const sign = feature<SignTransactionFeature>(this.wallet, "sui:signTransaction");
    if (!sign) throw new Error(`${this.wallet.name} cannot sign transactions.`);
    const encoded = toBase64(bytes);
    const { signature } = await sign.signTransaction({
      transaction: { toJSON: async () => encoded },
      account: this.account,
      chain: CHAIN,
    });
    return { bytes: encoded, signature };
  }
  override sign(): never {
    throw new Error("Connected wallets sign whole transactions only.");
  }
  override getKeyScheme(): SignatureScheme {
    throw new Error("A connected wallet does not expose its key scheme.");
  }
  override getPublicKey(): PublicKey {
    throw new Error("A connected wallet does not expose its public key here.");
  }
}

async function walletSigner(expectedAddress: string): Promise<Signer> {
  const wallets = listSuiWallets();
  let remembered: string | null = null;
  try {
    remembered = window.localStorage.getItem(REMEMBERED_WALLET);
  } catch {
    // Ignore.
  }
  const ordered = [...wallets].sort((a, b) => Number(b.name === remembered) - Number(a.name === remembered));
  for (const wallet of ordered) {
    let accounts = wallet.accounts;
    if (!accounts.some((account) => account.address === expectedAddress)) {
      if (wallet.name !== remembered) continue;
      accounts = await connectWallet(wallet);
    }
    const account = accounts.find((candidate) => candidate.address === expectedAddress);
    if (account) return new WalletStandardSigner(wallet, account);
  }
  if (wallets.length === 0) {
    throw new OwnerSignerError("wallet_missing", "Open this page in a browser with your Sui wallet (e.g. Slush) installed.");
  }
  throw new OwnerSignerError(
    "wallet_mismatch",
    `Connect the wallet that owns this account (${expectedAddress.slice(0, 8)}…${expectedAddress.slice(-6)}).`,
  );
}

/** For the wallet kind: build a signer from an account the user just picked in the connect dialog. */
export function signerForWalletAccount(wallet: Wallet, account: WalletAccount): Signer {
  return new WalletStandardSigner(wallet, account);
}

// ---- One entry point ----

export async function ownerSigner(account: { ownerKind: OwnerKind; ownerAddress: string }): Promise<Signer> {
  if (account.ownerKind === "zklogin") return zkLoginSigner(account.ownerAddress);
  if (account.ownerKind === "wallet") return walletSigner(account.ownerAddress);
  const legacy = loadWallet("owner");
  if (!legacy || legacy.address !== account.ownerAddress) {
    throw new OwnerSignerError(
      "browser_key_missing",
      "This account's owner key is stored in the browser where it was created. Open it there to sign.",
    );
  }
  return legacy.keypair;
}

/** Proves the browser-key owner controls its address (accounts created before zkLogin). */
export async function signMessageWithBrowserKey(keypair: Ed25519Keypair, message: string): Promise<string> {
  const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(message));
  return signature;
}
