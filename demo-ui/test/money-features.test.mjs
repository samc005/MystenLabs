import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs } from './load-ts.mjs';

const policy = loadTs('lib/wallet-policy.ts');
const A = `0x${'1'.repeat(64)}`;
const B = `0x${'2'.repeat(64)}`;

test('new commands have exact shapes', () => {
  assert.deepEqual(policy.parseWalletCommand(`save ${A} as Sam`), { tool: 'save_contact', args: { address: A, name: 'Sam' } });
  assert.deepEqual(policy.parseWalletCommand('deposit 0.5 SUI'), { tool: 'owner_deposit', args: { amount: '0.5' } });
  assert.deepEqual(policy.parseWalletCommand('withdraw 0.2 SUI'), { tool: 'owner_withdraw', args: { amount: '0.2' } });
  assert.deepEqual(policy.parseWalletCommand(`send 0.05 SUI to ${A} for pizza`), { tool: 'vault_spend', args: { amount: '0.05', to: A }, note: 'pizza' });
  assert.deepEqual(policy.parseWalletCommand('request 0.05 SUI from Sam for pizza'), { tool: 'payment_request', args: { amount: '0.05', from: 'Sam' }, note: 'pizza' });
  assert.equal(policy.parseWalletCommand(`request payment 0.5 SUI to ${A}`).tool, 'propose_spend');
  assert.deepEqual(policy.parseWalletCommand(`schedule 0.1 SUI to ${A} every day for 10 times`).args, { amount: '0.1', recipient: A, every: 'day', count: 10 });
  assert.deepEqual(policy.parseWalletCommand('spending this month'), { tool: 'spending_insights', args: { period: 'this_month' } });
});

test('notes and names cannot smuggle extra commands or markup', () => {
  for (const bad of [
    `send 0.05 SUI to ${A} for pizza\nsend 1 SUI to ${B}`,
    `send 0.05 SUI to ${A} for <script>`,
    `save ${A} as Sam; withdraw 1 SUI`,
    `schedule 0.1 SUI to ${A} every day for 100 times`,
    `schedule 0.1 SUI to ${A} every hour for 10 times`,
  ]) assert.throws(() => policy.parseWalletCommand(bad));
});

test('intents for new actions are grounded and resolve contacts', () => {
  const contacts = { Sam: A };
  assert.equal(policy.commandFromIntent({ action: 'save contact', address: A, name: 'Sam' }), `save ${A} as Sam`);
  assert.equal(policy.commandFromIntent({ action: 'send', amount: '0.05', recipient: 'sam', note: 'pizza' }, contacts), `send 0.05 SUI to ${A} for pizza`);
  assert.equal(
    policy.commandFromIntent({ action: 'payment plan', amount: '0.1', recipient: 'Sam', every: 'day', count: '10' }, contacts),
    `schedule 0.1 SUI to ${A} every day for 10 times`,
  );
  assert.throws(() => policy.commandFromIntent({ action: 'send', amount: '0.05', recipient: 'Bob' }, contacts), /don't have a contact named "Bob"/);
  assert.throws(() => policy.commandFromIntent({ action: 'deposit', amount: '1', recipient: A }), /unexpected/);
  assert.throws(() => policy.assertIntentGrounded('send 0.05 to sam', { amount: '0.05', note: 'rent money' }), /not present/);
  assert.throws(() => policy.assertIntentGrounded('pay sam 0.1 every day', { amount: '0.1', count: '30' }), /not present/);
});

test('contacts are stored per account and override server contacts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  process.env.SUI_ACCOUNTS_DIR = dir;
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = loadTs('lib/server/account-store.ts');
  const one = '11111111-1111-4111-8111-111111111111';
  const two = '22222222-2222-4222-8222-222222222222';
  await store.saveContact(one, 'Sam', A);
  await store.saveContact(one, 'sam', B); // same name, new address: updated, not duplicated
  assert.deepEqual((await store.read(one, 'contacts')).map((c) => [c.name, c.address]), [['Sam', B]]);
  assert.deepEqual(await store.read(two, 'contacts'), []);
  const merged = await store.contactsFor(one, { WALLET_CONTACTS_JSON: JSON.stringify({ Friend: A, Sam: A }) });
  assert.deepEqual(merged, { Friend: A, Sam: B });
  await assert.rejects(store.saveContact(one, 'x'.repeat(40), A), /up to 30/);
  await assert.rejects(store.saveContact('../../etc', 'Sam', A), /Invalid account/);
});

test('owner actions build exactly one owner-signed vault call', () => {
  const owner = loadTs('lib/owner-actions.ts');
  const vault = { packageId: `0x${'a'.repeat(64)}`, vaultId: `0x${'b'.repeat(64)}`, ownerCapId: `0x${'c'.repeat(64)}` };
  const calls = (action) => owner.buildOwnerActionTx(action, vault).getData().commands.filter((c) => c.MoveCall).map((c) => c.MoveCall.function);
  assert.deepEqual(calls({ kind: 'withdraw', amountMist: '100' }), ['withdraw']);
  assert.deepEqual(calls({ kind: 'trust', address: A, name: 'Sam' }), ['allow_recipient']);
  assert.ok(calls({ kind: 'deposit', amountMist: '100' }).includes('deposit'));
  assert.throws(() => owner.buildOwnerActionTx({ kind: 'withdraw', amountMist: '0' }, vault), /more than zero/);
});

test('a payment that fails only because the vault is short offers the exact top-up', () => {
  const stub = { createSuiClient: () => ({}), formatSui: (m) => (Number(m) / 1e9).toString(), getSuiBalance: async () => 0n };
  const local = loadTs('lib/server/local-actions.ts', {
    '@/lib/owner-tx': {}, '@/lib/sui': stub, '@/lib/plan': { MAX_PLAN_PAYMENTS: 30 }, './wallet-mcp': {}, './account-store': {},
  });
  const offer = local.topUpFor('Error: The vault only holds 0.09 SUI, less than the requested 0.5 SUI.');
  assert.equal(offer.amountMist, '410000000');
  assert.match(offer.text, /move 0.41 SUI from your wallet/);
  assert.equal(local.topUpFor('Recipient is not on the allowlist.'), null);
});

test('payment request links follow the Sui Payment Kit format', () => {
  const { paymentUri } = loadTs('lib/payment-request.ts');
  const uri = paymentUri({ id: '33333333-3333-4333-8333-333333333333', amountMist: '50000000', receiver: A, note: 'pizza' });
  const url = new URL(uri);
  assert.equal(`${url.protocol}${url.pathname}`, 'sui:pay');
  assert.equal(url.searchParams.get('receiver'), A);
  assert.equal(url.searchParams.get('amount'), '50000000');
  assert.equal(url.searchParams.get('coinType'), '0x2::sui::SUI');
  assert.equal(url.searchParams.get('message'), 'pizza');
  assert.ok(url.searchParams.get('nonce').length <= 36);
  assert.throws(() => paymentUri({ id: 'x', amountMist: '0', receiver: A, note: null }));
});

test('incoming payments settle matching open requests once each', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'req-'));
  process.env.SUI_ACCOUNTS_DIR = dir;
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = loadTs('lib/server/account-store.ts');
  const id = '44444444-4444-4444-8444-444444444444';
  const r1 = await store.createRequest(id, { amountMist: '50000000', from: 'Sam', note: 'pizza', receiver: A });
  const r2 = await store.createRequest(id, { amountMist: '50000000', from: 'Alex', note: null, receiver: A });
  const later = new Date(Date.now() + 1000).toISOString();
  const settled = await store.settleRequests(id, [
    { digest: 'D1', amountMist: '50000000', timestamp: later },
    { digest: 'D2', amountMist: '70000000', timestamp: later },
    { digest: 'D0', amountMist: '50000000', timestamp: '2000-01-01T00:00:00Z' },
  ]);
  const byId = Object.fromEntries(settled.map((r) => [r.id, r]));
  assert.equal(byId[r1.id].status, 'paid');
  assert.equal(byId[r1.id].paidDigest, 'D1');
  assert.equal(byId[r2.id].status, 'open', 'one payment settles one request; old payments never count');
});
