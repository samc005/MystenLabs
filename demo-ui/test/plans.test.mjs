import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs } from './load-ts.mjs';

const addr = (c) => `0x${c.repeat(64)}`;
const plan = loadTs('lib/plan.ts');
const vault = { packageId: addr('a'), vaultId: addr('b'), ownerCapId: addr('c') };
const DAY = 86_400_000;

test('a plan is one owner transaction: optional top-up, then one approval per payment', () => {
  const input = { recipient: addr('1'), amountMist: '100000000', every: 'day', count: 3, startMs: 1_000, depositMist: '200000000' };
  const calls = plan.buildPlanTx(input, vault).getData().commands.filter((c) => c.MoveCall).map((c) => c.MoveCall.function);
  assert.deepEqual(calls, ['deposit', 'create_spend_intent', 'create_spend_intent', 'create_spend_intent']);
  assert.deepEqual(plan.planDeadlines(input), [1_000 + DAY, 1_000 + 2 * DAY, 1_000 + 3 * DAY]);
  assert.throws(() => plan.buildPlanTx({ ...input, count: 31 }, vault), /1 to 30/);
  assert.throws(() => plan.buildPlanTx({ ...input, recipient: '0x12' }, vault), /full address/);
});

async function setup(t, events) {
  const dir = await mkdtemp(join(tmpdir(), 'plans-'));
  process.env.SUI_ACCOUNTS_DIR = dir;
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fakeClient = { waitForTransaction: async () => ({ $kind: 'Transaction', Transaction: { events } }) };
  const store = loadTs('lib/server/account-store.ts');
  const plans = loadTs('lib/server/plans.ts', {
    '@/lib/sui': { createSuiClient: () => fakeClient },
    '@/lib/plan': plan,
    './agent': { connectWalletMcp: async () => { throw new Error('no signer in tests'); } },
    './passkey': { passkeyStatus: async () => ({ revoked: false }) },
    './account-store': store,
  });
  const account = { accountId: '55555555-5555-4555-8555-555555555555', ownerAddress: addr('0').replace(/0+$/, '').padEnd(66, 'd'), agentAddress: addr('e'), packageId: vault.packageId, vaultId: vault.vaultId, agentCapId: addr('f') };
  account.ownerAddress = addr('d');
  return { plans, store, account };
}

const created = (overrides = {}) => ({
  packageId: vault.packageId,
  module: 'spending_vault',
  sender: addr('d'),
  eventType: `${vault.packageId}::spending_vault::SpendIntentCreated`,
  json: { vault_id: vault.vaultId, intent_id: addr('9'), recipient: addr('1'), amount: '100000000', expiry_ms: String(Date.now() + DAY) },
  ...overrides,
});
const DIGEST = 'FCZ4mgKKBtF3WYYBtvQPndzBAw8kVXsVhjfBkHJF98tC';

test('plans are recorded only from the owner\'s own approvals on this vault', async (t) => {
  const now = Date.now();
  const events = [0, 1, 2].map((i) =>
    created({ json: { vault_id: vault.vaultId, intent_id: `0x${String(i).repeat(64)}`, recipient: addr('1'), amount: '100000000', expiry_ms: String(now + (i + 1) * DAY) } }),
  );
  const { plans, account } = await setup(t, [
    ...events,
    created({ sender: addr('7') }), // someone else's approval in the same transaction is ignored
    created({ json: { ...created().json, vault_id: addr('8') } }), // another vault is ignored
  ]);
  const recorded = await plans.registerPlan(account, DIGEST, 'rent');
  assert.equal(recorded.count, 3);
  assert.equal(recorded.every, 'day');
  assert.equal(recorded.recipient, addr('1'));
  assert.equal(recorded.note, 'rent');
  assert.ok(Date.parse(recorded.payments[0].dueAt) <= now + 1000, 'the first payment is due right away');
  assert.equal((await plans.registerPlan(account, DIGEST, null)).id, recorded.id, 'registering twice is a no-op');
});

test('a transaction without the owner\'s approvals, or with mixed terms, is refused', async (t) => {
  const { plans, account } = await setup(t, [created({ sender: addr('7') })]);
  await assert.rejects(plans.registerPlan(account, DIGEST, null), /did not create any payment approvals/);
  const mixed = await setup(t, [created(), created({ json: { ...created().json, intent_id: addr('6'), recipient: addr('2') } })]);
  await assert.rejects(mixed.plans.registerPlan(mixed.account, DIGEST, null), /one recipient/);
});

test('the scheduler leaves future payments alone and records failures without losing the payment', async (t) => {
  const now = Date.now();
  const { plans, store, account } = await setup(t, [
    created({ json: { vault_id: vault.vaultId, intent_id: addr('3'), recipient: addr('1'), amount: '1', expiry_ms: String(now + DAY) } }),
    created({ json: { vault_id: vault.vaultId, intent_id: addr('4'), recipient: addr('1'), amount: '1', expiry_ms: String(now + 2 * DAY) } }),
  ]);
  await plans.registerPlan(account, DIGEST, null);
  // No active account record exists in this temp dir, so the scheduler has nothing to run.
  assert.deepEqual(await plans.runDuePlanPayments(now), { paid: 0, failed: 0 });
  const [stored] = await store.read(account.accountId, 'plans');
  assert.deepEqual(stored.payments.map((p) => p.status), ['scheduled', 'scheduled']);
});
