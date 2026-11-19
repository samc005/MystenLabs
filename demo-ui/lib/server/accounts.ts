// Accounts: one owner wallet, one agent address, one vault.
//
// The server stores only PUBLIC identifiers here. The owner key lives in the user's browser
// and the agent key lives inside the signer daemon, so this file leaks nothing that can move
// money. Writes are serialized and atomic so concurrent requests cannot corrupt or duplicate.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";

export interface AccountVault {
  packageId: string;
  vaultId: string;
  ownerCapId: string;
  agentCapId: string;
}

export interface Account {
  id: string;
  ownerAddress: string;
  agentAddress: string;
  /** pending: agent key minted, vault not yet verified on-chain. active: vault verified. */
  status: "pending" | "active";
  vault?: AccountVault;
  createdAt: string;
  activatedAt?: string;
}

const accountsDir = () => process.env.SUI_ACCOUNTS_DIR || join(process.cwd(), ".accounts");
const accountsFile = () => join(accountsDir(), "accounts.json");

async function load(): Promise<Account[]> {
  try {
    return JSON.parse(await readFile(accountsFile(), "utf8")) as Account[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function save(accounts: Account[]): Promise<void> {
  await mkdir(accountsDir(), { recursive: true, mode: 0o700 });
  const temporary = join(accountsDir(), `accounts.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(accounts, null, 2), { mode: 0o600, flag: "wx" });
  await rename(temporary, accountsFile());
}

let queue: Promise<unknown> = Promise.resolve();

function mutate<T>(change: (accounts: Account[]) => Promise<T> | T): Promise<T> {
  const run = queue.then(async () => {
    const accounts = await load();
    const result = await change(accounts);
    await save(accounts);
    return result;
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function requireOwnerAddress(value: unknown): string {
  if (typeof value !== "string" || !isValidSuiAddress(value)) throw new Error("Owner address must be a Sui address.");
  return normalizeSuiAddress(value);
}

export async function getAccount(id: string): Promise<Account | undefined> {
  return (await load()).find((account) => account.id === id);
}

export async function getAccountByOwner(ownerAddress: string): Promise<Account | undefined> {
  const owner = requireOwnerAddress(ownerAddress);
  return (await load()).find((account) => account.ownerAddress === owner);
}

/**
 * Returns the owner's account, minting an agent key only the first time. Calling this again
 * (a page reload, a retry after a failed transaction) never mints a second agent.
 */
export async function createPendingAccount(
  ownerAddress: string,
  provisionAgent: () => Promise<string>,
): Promise<Account> {
  const owner = requireOwnerAddress(ownerAddress);
  return mutate(async (accounts) => {
    const existing = accounts.find((account) => account.ownerAddress === owner);
    if (existing) return existing;
    const agentAddress = await provisionAgent();
    const account: Account = {
      id: randomUUID(),
      ownerAddress: owner,
      agentAddress: requireOwnerAddress(agentAddress),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    accounts.push(account);
    return account;
  });
}

/** Marks the account active. Callers must have verified the vault on-chain first. */
export function activateAccount(id: string, vault: AccountVault): Promise<Account> {
  return mutate((accounts) => {
    const account = accounts.find((candidate) => candidate.id === id);
    if (!account) throw new Error("Unknown account.");
    if (account.status === "active") {
      if (account.vault?.vaultId === vault.vaultId) return account;
      throw new Error("This account already has a different vault.");
    }
    account.status = "active";
    account.vault = vault;
    account.activatedAt = new Date().toISOString();
    return account;
  });
}
