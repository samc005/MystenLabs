// Who is calling, and which vault they may touch. Every wallet-facing route resolves this first.
//
// There is deliberately no fallback to a shared or default vault: a caller with no active account
// is refused, so one user can never act on another user's vault (or the operator's) by omission.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { accountsDir, getAccountByUser, type Account } from "./accounts";
import { userFromRequest } from "./session";

export class AccountError extends Error {
  constructor(
    readonly status: number,
    readonly code: "sign_in" | "no_account",
    message: string,
  ) {
    super(message);
  }
}

export interface AccountContext {
  accountId: string;
  userId: string;
  ownerAddress: string;
  agentAddress: string;
  packageId: string;
  vaultId: string;
  agentCapId: string;
  /** This account's own proposals directory. No other account can read or write it. */
  proposalsDir: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The proposals directory for an account. The id is validated so it can never escape the root. */
export function proposalsDirFor(accountId: string): string {
  if (!UUID.test(accountId)) throw new Error("Invalid account id.");
  return path.join(accountsDir(), "proposals", accountId);
}

export async function requireAccount(request: Request): Promise<AccountContext> {
  const user = userFromRequest(request);
  if (!user) throw new AccountError(401, "sign_in", "Sign in with Google first.");
  const account = await getAccountByUser(user.sub);
  if (!account || account.status !== "active" || !account.vault) {
    throw new AccountError(403, "no_account", "Create your account first.");
  }
  return contextFor(account);
}

/** The context for an active account, without a request. Used by the plan scheduler. */
export async function contextFor(account: Account): Promise<AccountContext> {
  if (account.status !== "active" || !account.vault) throw new Error("Account is not active.");
  const proposalsDir = proposalsDirFor(account.id);
  await mkdir(proposalsDir, { recursive: true, mode: 0o700 });
  return {
    accountId: account.id,
    userId: account.userId,
    ownerAddress: account.ownerAddress,
    agentAddress: account.agentAddress,
    packageId: account.vault.packageId,
    vaultId: account.vault.vaultId,
    agentCapId: account.vault.agentCapId,
    proposalsDir,
  };
}

/** A ready JSON response for sign-in and account errors, or null for anything else. */
export function accountErrorResponse(error: unknown): Response | null {
  if (!(error instanceof AccountError)) return null;
  return Response.json({ error: error.message, code: error.code }, { status: error.status });
}

/**
 * The only vault-related environment an account's MCP server receives. The agent address and
 * vault IDs come from the account record, never from this process's own environment.
 */
export function mcpEnvFor(account: AccountContext): Record<string, string> {
  return {
    SUI_NETWORK: "testnet",
    SUI_ADDRESS: account.agentAddress,
    SUI_VAULT_PACKAGE_ID: account.packageId,
    SUI_VAULT_ID: account.vaultId,
    SUI_VAULT_AGENT_CAP_ID: account.agentCapId,
    SUI_PROPOSALS_DIR: account.proposalsDir,
  };
}
