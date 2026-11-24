import { recordProposalExecution } from "./proposals";
import { saveNote } from "./account-store";
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { consumeApproval, passkeyStatus } from './passkey';
import { connectWalletMcp } from './agent';
import type { AccountContext } from './account-context';

// Each prepared transaction belongs to the account that asked for it. Another account cannot
// execute it even if it somehow learned the ID.
const prepared = new Map<string, { accountId: string; command: string; bytes: string; summary: string; expires: number; note?: string }>();
export function rememberPrepared(accountId: string, command: string, bytes: string, summary = "", note?: string): string {
  for (const [id, value] of prepared) if (value.expires <= Date.now()) prepared.delete(id);
  if (prepared.size >= 100) throw new Error('Too many pending transactions. Wait for them to expire.');
  const id = randomUUID();
  prepared.set(id, { accountId, command, bytes, summary, expires: Date.now() + 120_000, ...(note ? { note } : {}) });
  return id;
}
export async function executePrepared(account: AccountContext, id: string, approvalId: string) {
  if ((await passkeyStatus()).revoked) throw new Error('Wallet access is locked.');
  const transaction = prepared.get(id);
  // A foreign account's transaction reads exactly like a missing one, and burns no approval.
  if (!transaction || transaction.accountId !== account.accountId || transaction.expires <= Date.now()) throw new Error('Transaction missing, used, or expired. Prepare a new command.');
  const hash = createHash('sha256').update(JSON.stringify({ action: 'execute-wallet-command', id, command: transaction.command, summary: transaction.summary })).digest('hex');
  await consumeApproval(approvalId, hash);
  // Claim before any asynchronous work: concurrent requests cannot submit twice.
  if (!prepared.delete(id)) throw new Error('Transaction already claimed.');
  const directory = process.env.SUI_SIGNER_STATE_DIR;
  if (!directory || !path.isAbsolute(directory)) throw new Error('Configure the trusted backend SUI_SIGNER_STATE_DIR.');
  const info = await stat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new Error('Signer state must be private and owned by the trusted backend user.');
  const mcp = await connectWalletMcp(account);
  try {
    const simulation = await mcp.callTool({ name: 'estimate_gas', arguments: { transactionBase64: transaction.bytes } });
    if ((await passkeyStatus()).revoked) throw new Error("Wallet access is locked.");
    if (simulation.isError) throw new Error('Simulation refused this transaction. Prepare a new command.');
    const input = { network: 'testnet', proposalId: id, transactionBytes: transaction.bytes, policyDecision: { id, allowed: true } };
    const approvals = path.join(directory, 'approvals');
    await mkdir(approvals, { recursive: true, mode: 0o700 });
    const temp = path.join(approvals, id + '.tmp');
    await writeFile(temp, JSON.stringify({ ...input, expiresAtMs: Math.min(transaction.expires, Date.now() + 30_000) }), { mode: 0o600, flag: 'wx' });
    await rename(temp, path.join(approvals, id + '.json'));
    const result = await mcp.callTool({ name: 'execute_approved_transaction', arguments: input });
    const confirmation = result.structuredContent as { digest?: unknown; confirmed?: unknown } | undefined;
    // The note is part of the command the user approved with their passkey, so it is theirs to keep.
    if (!result.isError && confirmation?.confirmed === true && typeof confirmation.digest === "string" && transaction.note) {
      await saveNote(account.accountId, confirmation.digest, transaction.note).catch(() => undefined);
    }
    const proposal = transaction.command.match(/^execute (swap|payment) (prop_[0-9a-f]{10})$/);
    if (!result.isError && confirmation?.confirmed === true && typeof confirmation.digest === "string" && proposal) {
      try {
        await recordProposalExecution(proposal[2]!, proposal[1] as "swap" | "payment", confirmation.digest, account.proposalsDir);
      } catch {
        // The chain already confirmed: a UI storage failure must never imply a safe retry.
        return { ...result, content: [...(result.content ?? []), { type: "text" as const, text: "Confirmed on chain, but the proposal card could not be updated. Check the digest before retrying." }] };
      }
    }
    return result;
  } finally { await mcp.close().catch(() => undefined); }
}
