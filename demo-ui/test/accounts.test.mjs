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

test('an owner gets exactly one agent key, even under concurrent requests', async (t) => {
  const { accounts } = await fresh(t);
  let minted = 0;
  const provision = async () => addr(String(++minted));
  const results = await Promise.all([1, 2, 3].map(() => accounts.createPendingAccount(addr('a'), provision)));
  assert.equal(minted, 1);
  assert.equal(new Set(results.map((a) => a.id)).size, 1);
  assert.equal(results[0].status, 'pending');
  const other = await accounts.createPendingAccount(addr('b'), provision);
  assert.notEqual(other.agentAddress, results[0].agentAddress);
});

test('accounts persist privately and activate once, only with their own vault', async (t) => {
  const { dir, accounts } = await fresh(t);
  const created = await accounts.createPendingAccount(addr('a'), async () => addr('9'));
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

test('malformed owner addresses are rejected before anything is minted', async (t) => {
  const { accounts } = await fresh(t);
  let minted = 0;
  await assert.rejects(accounts.createPendingAccount('not-an-address', async () => { minted++; return addr('9'); }), /Sui address/);
  assert.equal(minted, 0);
});

test('a failed provision leaves no account behind and can be retried', async (t) => {
  const { accounts } = await fresh(t);
  await assert.rejects(accounts.createPendingAccount(addr('a'), async () => { throw new Error('signer down'); }), /signer down/);
  assert.equal(await accounts.getAccountByOwner(addr('a')), undefined);
  assert.equal((await accounts.createPendingAccount(addr('a'), async () => addr('9'))).agentAddress, addr('9'));
});
