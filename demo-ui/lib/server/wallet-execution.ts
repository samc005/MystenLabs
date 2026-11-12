import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { consumeApproval, passkeyStatus } from './passkey';
import { connectWalletMcp } from './agent';

const prepared = new Map<string, { command: string; bytes: string; expires: number }>();
export function rememberPrepared(command: string, bytes: string): string {
  for (const [id, value] of prepared) if (value.expires <= Date.now()) prepared.delete(id);
  if (prepared.size >= 100) throw new Error('Too many pending transactions. Wait for them to expire.');
  const id = randomUUID();
  prepared.set(id, { command, bytes, expires: Date.now() + 120_000 });
  return id;
}
export async function executePrepared(id: string, approvalId: string) {
  if ((await passkeyStatus()).revoked) throw new Error('Wallet access is locked.');
  const transaction = prepared.get(id);
  if (!transaction || transaction.expires <= Date.now()) throw new Error('Transaction missing, used, or expired. Prepare a new command.');
  const hash = createHash('sha256').update(JSON.stringify({ action: 'execute-wallet-command', id, command: transaction.command })).digest('hex');
  await consumeApproval(approvalId, hash);
  // Claim before any asynchronous work: concurrent requests cannot submit twice.
  if (!prepared.delete(id)) throw new Error('Transaction already claimed.');
  const directory = process.env.SUI_SIGNER_STATE_DIR;
  if (!directory || !path.isAbsolute(directory)) throw new Error('Configure the trusted backend SUI_SIGNER_STATE_DIR.');
  const info = await stat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new Error('Signer state must be private and owned by the trusted backend user.');
  const mcp = await connectWalletMcp();
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
    return await mcp.callTool({ name: 'execute_approved_transaction', arguments: input });
  } finally { await mcp.close().catch(() => undefined); }
}
