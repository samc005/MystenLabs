import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs } from './load-ts.mjs';

const addr = (c) => `0x${c.repeat(64)}`;
const vault = { packageId: addr('1'), vaultId: addr('2'), ownerCapId: addr('3'), agentCapId: addr('4') };

async function fresh(t) {
  const dir = await mkdtemp(join(tmpdir(), 'accounts-'));
  process.env.SUI_ACCOUNTS_DIR = dir;
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, accounts: loadTs('lib/server/accounts.ts') };
}

test('a sign-in gets exactly one agent key, even under concurrent requests', async (t) => {
  const { accounts } = await fresh(t);
  let minted = 0;
  const provision = async () => addr(String(++minted));
  const input = { ownerAddress: addr('a'), userId: 'sub-1' };
  const results = await Promise.all([1, 2, 3].map(() => accounts.createPendingAccount(input, provision)));
  assert.equal(minted, 1);
  assert.equal(new Set(results.map((a) => a.id)).size, 1);
  assert.equal(results[0].status, 'pending');
  assert.equal(results[0].userId, 'sub-1');
  const other = await accounts.createPendingAccount({ ownerAddress: addr('b'), userId: 'sub-2' }, provision);
  assert.notEqual(other.agentAddress, results[0].agentAddress);
});

test('one account per sign-in, and one sign-in per wallet', async (t) => {
  const { accounts } = await fresh(t);
  const provision = async () => addr('9');
  await accounts.createPendingAccount({ ownerAddress: addr('a'), userId: 'sub-1' }, provision);
  await assert.rejects(
    accounts.createPendingAccount({ ownerAddress: addr('b'), userId: 'sub-1' }, provision),
    /different wallet/,
  );
  await assert.rejects(
    accounts.createPendingAccount({ ownerAddress: addr('a'), userId: 'sub-2' }, provision),
    /another account/,
  );
});

test('accounts persist privately and activate once, only with their own vault', async (t) => {
  const { dir, accounts } = await fresh(t);
  const created = await accounts.createPendingAccount({ ownerAddress: addr('a'), userId: 'sub-1' }, async () => addr('9'));
  assert.equal((await stat(join(dir, 'accounts.json'))).mode & 0o077, 0);

  const reloaded = loadTs('lib/server/accounts.ts');
  assert.equal((await reloaded.getAccountByOwner(addr('a'))).id, created.id);
  assert.equal((await reloaded.getAccount(created.id)).agentAddress, addr('9'));

  const active = await reloaded.activateAccount(created.id, vault);
  assert.equal(active.status, 'active');
  assert.deepEqual((await reloaded.activateAccount(created.id, vault)).vault, vault);
  await assert.rejects(reloaded.activateAccount(created.id, { ...vault, vaultId: addr('8') }), /different vault/);
  await assert.rejects(reloaded.activateAccount('missing', vault), /Unknown account/);
  assert.doesNotMatch(await readFile(join(dir, 'accounts.json'), 'utf8'), /secret/i);
});

test('malformed owner addresses and missing sign-ins are rejected before anything is minted', async (t) => {
  const { accounts } = await fresh(t);
  let minted = 0;
  const provision = async () => { minted++; return addr('9'); };
  await assert.rejects(accounts.createPendingAccount({ ownerAddress: 'not-an-address', userId: 'sub-1' }, provision), /Sui address/);
  await assert.rejects(accounts.createPendingAccount({ ownerAddress: addr('a'), userId: '' }, provision), /Sign in/);
  assert.equal(minted, 0);
});

test('a failed provision leaves no account behind and can be retried', async (t) => {
  const { accounts } = await fresh(t);
  const input = { ownerAddress: addr('a'), userId: 'sub-1' };
  await assert.rejects(accounts.createPendingAccount(input, async () => { throw new Error('signer down'); }), /signer down/);
  assert.equal(await accounts.getAccountByOwner(addr('a')), undefined);
  assert.equal((await accounts.createPendingAccount(input, async () => addr('9'))).agentAddress, addr('9'));
});
