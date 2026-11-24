import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs } from './load-ts.mjs';

const addr = (c) => `0x${c.repeat(64)}`;
const plan = loadTs('lib/plan.ts');
const approval = loadTs('lib/owner-approval.ts');
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
  const consumed = [];
  const used = new Set();
  const plans = loadTs('lib/server/plans.ts', {
    '@/lib/sui': { createSuiClient: () => fakeClient },
    '@/lib/plan': plan,
    './agent': { connectWalletMcp: async () => { throw new Error('no signer in tests'); } },
    '@/lib/owner-approval': approval,
    './passkey': {
      passkeyStatus: async () => ({ revoked: false }),
      consumeApproval: async (id, hash) => {
        if (id !== 'ok' || used.has(id + hash)) throw new Error('Passkey approval is missing, expired, already used, or bound to different action data.');
        used.add(id + hash);
        consumed.push(hash);
      },
    },
    './account-store': store,
  });
  const account = { accountId: '55555555-5555-4555-8555-555555555555', ownerAddress: addr('0').replace(/0+$/, '').padEnd(66, 'd'), agentAddress: addr('e'), packageId: vault.packageId, vaultId: vault.vaultId, agentCapId: addr('f') };
  account.ownerAddress = addr('d');
  return { plans, store, account, consumed };
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
  const recorded = await plans.registerPlan(account, DIGEST, 'rent', 'ok');
  assert.equal(recorded.count, 3);
  assert.equal(recorded.every, 'day');
  assert.equal(recorded.recipient, addr('1'));
  assert.equal(recorded.note, 'rent');
  assert.ok(Date.parse(recorded.payments[0].dueAt) <= now + 1000, 'the first payment is due right away');
  assert.equal((await plans.registerPlan(account, DIGEST, null, 'ok')).id, recorded.id, 'registering twice is a no-op');
});

test('a transaction without the owner\'s approvals, or with mixed terms, is refused', async (t) => {
  const { plans, account } = await setup(t, [created({ sender: addr('7') })]);
  await assert.rejects(plans.registerPlan(account, DIGEST, null, 'ok'), /did not create any payment approvals/);
  const mixed = await setup(t, [created(), created({ json: { ...created().json, intent_id: addr('6'), recipient: addr('2') } })]);
  await assert.rejects(mixed.plans.registerPlan(mixed.account, DIGEST, null, 'ok'), /one recipient/);
});

test('the scheduler leaves future payments alone and records failures without losing the payment', async (t) => {
  const now = Date.now();
  const { plans, store, account } = await setup(t, [
    created({ json: { vault_id: vault.vaultId, intent_id: addr('3'), recipient: addr('1'), amount: '1', expiry_ms: String(now + DAY) } }),
    created({ json: { vault_id: vault.vaultId, intent_id: addr('4'), recipient: addr('1'), amount: '1', expiry_ms: String(now + 2 * DAY) } }),
  ]);
  await plans.registerPlan(account, DIGEST, null, 'ok');
  // No active account record exists in this temp dir, so the scheduler has nothing to run.
  assert.deepEqual(await plans.runDuePlanPayments(now), { paid: 0, failed: 0 });
  const [stored] = await store.read(account.accountId, 'plans');
  assert.deepEqual(stored.payments.map((p) => p.status), ['scheduled', 'scheduled']);
});

test('insights count only real spending, by period, recipient and who paid', () => {
  const { computeInsights, describeInsights } = loadTs('lib/server/insights.ts');
  const now = new Date('2026-11-23T12:00:00Z');
  const at = (daysAgo) => new Date(now.getTime() - daysAgo * DAY).toISOString();
  const entry = (o) => ({ digest: Math.random().toString(36), success: true, direction: 'out', counterparty: null, note: null, by: 'cipher', ...o });
  const entries = [
    entry({ kind: 'payment', amountMist: '100000000', timestamp: at(1), counterparty: { address: addr('1'), label: 'Sam' }, note: 'pizza' }),
    entry({ kind: 'payment', amountMist: '50000000', timestamp: at(2), counterparty: { address: addr('1'), label: 'Sam' } }),
    entry({ kind: 'sent', by: 'you', amountMist: '200000000', timestamp: at(3), counterparty: { address: addr('2'), label: null } }),
    entry({ kind: 'deposit', by: 'you', amountMist: '500000000', timestamp: at(1) }), // moving to your own vault is not spending
    entry({ kind: 'payment', amountMist: '900000000', timestamp: at(1), success: false, counterparty: { address: addr('1'), label: 'Sam' } }),
    entry({ kind: 'received', by: 'someone else', direction: 'in', amountMist: '70000000', timestamp: at(2) }),
    entry({ kind: 'payment', amountMist: '300000000', timestamp: at(20), counterparty: { address: addr('3'), label: null } }),
  ];
  const week = computeInsights(entries, 'this_week', now);
  assert.equal(week.spentMist, '350000000');
  assert.equal(week.payments, 3);
  assert.equal(week.spentByCipherMist, '150000000');
  assert.equal(week.spentByYouMist, '200000000');
  assert.equal(week.receivedMist, '70000000');
  assert.equal(week.series.length, 7);
  assert.deepEqual(week.topRecipients.map((r) => [r.address, r.totalMist, r.count]), [[addr('2'), '200000000', 1], [addr('1'), '150000000', 2]]);
  assert.deepEqual(week.notes.map((n) => n.note), ['pizza']);
  assert.equal(computeInsights(entries, 'this_month', now).spentMist, '650000000');
  assert.match(describeInsights(week, (m) => (Number(m) / 1e9).toString()), /spent 0.35 SUI in the last 7 days, across 3 payments/);
});

const sha = async (value) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
};

test('a plan is recorded only with a passkey approval for exactly its terms', async (t) => {
  const now = Date.now();
  const events = [0, 1].map((i) =>
    created({ json: { vault_id: vault.vaultId, intent_id: `0x${String(i).repeat(64)}`, recipient: addr('1'), amount: '100000000', expiry_ms: String(now + (i + 1) * DAY) } }),
  );
  const { plans, account, consumed } = await setup(t, events);
  await assert.rejects(plans.registerPlan(account, DIGEST, null, 'forged'), /Passkey approval/);
  await plans.registerPlan(account, DIGEST, null, 'ok');
  // The server hashed the chain's terms exactly as the browser hashes the card's terms.
  assert.deepEqual(consumed, [await sha(approval.planApproval(addr('1'), '100000000', 2))]);
});

test('a top-up payment is sent only for one approved intent with a matching passkey approval', async (t) => {
  const pay = created({ json: { ...created().json, expiry_ms: String(Date.now() + 600_000) } });
  const { plans, account, consumed } = await setup(t, [pay]);
  await assert.rejects(plans.sendOwnerApprovedPayment(account, DIGEST, 'forged', null), /Passkey approval/);
  // A valid approval reaches the signer step (stubbed to fail here), after checking these exact terms.
  await assert.rejects(plans.sendOwnerApprovedPayment(account, DIGEST, 'ok', null), /SUI_SIGNER_STATE_DIR|no signer in tests/);
  assert.deepEqual(consumed, [await sha(approval.paymentApproval(addr('1'), '100000000'))]);
  // A retry of the same approved payment needs no new passkey approval.
  await assert.rejects(plans.sendOwnerApprovedPayment(account, DIGEST, null, null), /SUI_SIGNER_STATE_DIR|no signer in tests/);
  assert.equal(consumed.length, 1);
  // ...but another account cannot ride on it.
  await assert.rejects(plans.sendOwnerApprovedPayment({ ...account, accountId: '66666666-6666-4666-8666-666666666666' }, DIGEST, null, null), /Passkey approval/);

  const two = await setup(t, [pay, created({ json: { ...pay.json, intent_id: addr('6') } })]);
  await assert.rejects(two.plans.sendOwnerApprovedPayment(two.account, DIGEST, 'ok', null), /exactly one payment/);
  const expired = await setup(t, [created({ json: { ...pay.json, expiry_ms: String(Date.now() - 1) } })]);
  await assert.rejects(expired.plans.sendOwnerApprovedPayment(expired.account, DIGEST, 'ok', null), /expired/);
  assert.equal(expired.consumed.length, 0, 'an expired approval burns no passkey approval');
});
