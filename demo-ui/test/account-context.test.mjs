import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs } from './load-ts.mjs';

process.env.SESSION_SECRET = 'x'.repeat(40);
const session = loadTs('lib/server/session.ts');
const addr = (c) => `0x${c.repeat(64)}`;
const ID = '3f2b1c9e-0a4d-4e6b-9c1d-7a8b9c0d1e2f';
const ACTIVE = {
  id: ID, userId: 'sub-1', ownerAddress: addr('a'), agentAddress: addr('b'), status: 'active',
  vault: { packageId: addr('1'), vaultId: addr('2'), ownerCapId: addr('3'), agentCapId: addr('4') },
};

async function setup(t, accounts) {
  const dir = await mkdtemp(join(tmpdir(), 'ctx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ctx = loadTs('lib/server/account-context.ts', {
    './accounts': { accountsDir: () => dir, getAccountByUser: async (sub) => accounts.find((a) => a.userId === sub) },
    './session': session,
  });
  return { dir, ctx };
}

const signedIn = (sub) =>
  new Request('http://localhost:3000/', {
    headers: { cookie: `${session.SESSION_COOKIE}=${session.seal({ sub, email: 'a@example.com' }, 60_000)}` },
  });

test('no session means sign in; no active account means create one', async (t) => {
  const { ctx } = await setup(t, [{ ...ACTIVE, userId: 'sub-pending', status: 'pending', vault: undefined }]);
  await assert.rejects(ctx.requireAccount(new Request('http://localhost:3000/')), (e) => e.status === 401 && e.code === 'sign_in');
  await assert.rejects(ctx.requireAccount(signedIn('sub-nobody')), (e) => e.status === 403 && e.code === 'no_account');
  await assert.rejects(ctx.requireAccount(signedIn('sub-pending')), (e) => e.status === 403 && e.code === 'no_account');
});

test('an active account resolves to its own vault, agent and private proposals directory', async (t) => {
  const { dir, ctx } = await setup(t, [ACTIVE]);
  const account = await ctx.requireAccount(signedIn('sub-1'));
  assert.equal(account.accountId, ID);
  assert.equal(account.vaultId, addr('2'));
  assert.equal(account.agentAddress, addr('b'));
  assert.equal(account.agentCapId, addr('4'));
  assert.equal(account.proposalsDir, join(dir, 'proposals', ID));
  assert.equal((await stat(account.proposalsDir)).mode & 0o077, 0);
});

test('one user can never resolve another user\'s account', async (t) => {
  const other = { ...ACTIVE, id: '11111111-2222-4333-8444-555555555555', userId: 'sub-2', vault: { ...ACTIVE.vault, vaultId: addr('9') } };
  const { ctx } = await setup(t, [ACTIVE, other]);
  assert.equal((await ctx.requireAccount(signedIn('sub-1'))).vaultId, addr('2'));
  assert.equal((await ctx.requireAccount(signedIn('sub-2'))).vaultId, addr('9'));
});

test('the MCP environment comes only from the account, never from this process', async (t) => {
  const { ctx } = await setup(t, [ACTIVE]);
  const before = { ...process.env };
  process.env.SUI_VAULT_ID = 'shared-vault-from-env';
  process.env.SUI_ADDRESS = 'shared-agent-from-env';
  try {
    const account = await ctx.requireAccount(signedIn('sub-1'));
    const env = ctx.mcpEnvFor(account);
    assert.equal(env.SUI_VAULT_ID, addr('2'));
    assert.equal(env.SUI_ADDRESS, addr('b'));
    assert.equal(env.SUI_VAULT_PACKAGE_ID, addr('1'));
    assert.equal(env.SUI_VAULT_AGENT_CAP_ID, addr('4'));
    assert.equal(env.SUI_PROPOSALS_DIR, account.proposalsDir);
    assert.deepEqual(Object.keys(env).sort(), ['SUI_ADDRESS', 'SUI_NETWORK', 'SUI_PROPOSALS_DIR', 'SUI_VAULT_AGENT_CAP_ID', 'SUI_VAULT_ID', 'SUI_VAULT_PACKAGE_ID']);
  } finally {
    for (const key of ['SUI_VAULT_ID', 'SUI_ADDRESS']) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
  }
});

test('an account id can never point the proposals directory outside its root', async (t) => {
  const { ctx } = await setup(t, []);
  for (const bad of ['../../etc', '..', '', ID + '/..', 'not-a-uuid']) assert.throws(() => ctx.proposalsDirFor(bad), /Invalid account id/);
});

test('account errors become JSON with a code; anything else is not swallowed', async (t) => {
  const { ctx } = await setup(t, []);
  const response = ctx.accountErrorResponse(new ctx.AccountError(403, 'no_account', 'Create your account first.'));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Create your account first.', code: 'no_account' });
  assert.equal(ctx.accountErrorResponse(new Error('boom')), null);
});
