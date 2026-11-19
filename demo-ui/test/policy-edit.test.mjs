import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs } from './load-ts.mjs';

const owner = loadTs('lib/owner-tx.ts');
const form = loadTs('lib/permission-form.ts');
const SUI = 1_000_000_000n;
const pkg = `0x${'1'.repeat(64)}`;
const vault = `0x${'2'.repeat(64)}`;
const cap = `0x${'3'.repeat(64)}`;
const friend = `0x${'5'.repeat(64)}`;
const other = `0x${'6'.repeat(64)}`;
const spendFieldId = `0x${'7'.repeat(64)}`;
const calendarFieldId = `0x${'8'.repeat(64)}`;
const addrBytes = (address) => Uint8Array.from(Buffer.from(address.slice(2), 'hex'));

const moveCalls = (tx) => tx.getData().commands.filter((c) => c.$kind === 'MoveCall').map((c) => c.MoveCall.function);

/** A policy as the chain would report it, for the form tests. */
function policy(overrides = {}) {
  return {
    perTxLimitMist: SUI / 10n,
    spend: { dailyCapMist: SUI / 10n, enforceRecipients: false },
    calendar: { dayCapMist: SUI / 10n, weekCapMist: SUI / 2n },
    allowedRecipients: [friend],
    ...overrides,
  };
}

test('an unchanged form is refused as nothing to change', () => {
  const p = policy();
  assert.throws(() => form.changesFor(form.formFrom(p), p), /Nothing to change/);
});

test('editing one field sends only that owner call', () => {
  const p = policy();
  const changes = form.changesFor({ ...form.formFrom(p), perTx: '0.25' }, p);
  const tx = owner.buildPolicyUpdateTx({ packageId: pkg, vaultId: vault, ownerCapId: cap, changes });
  assert.deepEqual(moveCalls(tx), ['set_per_tx_limit']);
});

test('recipient edits call allow and disallow only for the differences', () => {
  const p = policy();
  const changes = form.changesFor({ ...form.formFrom(p), recipients: [other] }, p);
  assert.deepEqual(changes.allowRecipients, [other]);
  assert.deepEqual(changes.disallowRecipients, [friend]);
  const tx = owner.buildPolicyUpdateTx({ packageId: pkg, vaultId: vault, ownerCapId: cap, changes });
  assert.deepEqual(moveCalls(tx), ['allow_recipient', 'disallow_recipient']);
});

test('the spend policy and calendar caps are each sent as one pair', () => {
  const p = policy();
  const spend = form.changesFor({ ...form.formFrom(p), enforce: true }, p);
  assert.deepEqual(spend.spend, { dailyCapMist: SUI / 10n, enforceRecipients: true });
  assert.equal(spend.calendar, undefined);

  const calendar = form.changesFor({ ...form.formFrom(p), weekCap: '1' }, p);
  assert.deepEqual(calendar.calendar, { dayCapMist: SUI / 10n, weekCapMist: SUI });
  assert.equal(calendar.spend, undefined);
});

test('an empty cap that is not set on-chain stays unset, never becomes zero', () => {
  const p = policy({ spend: null, calendar: null });
  const changes = form.changesFor({ ...form.formFrom(p), perTx: '0.25' }, p);
  assert.equal(changes.spend, undefined);
  assert.equal(changes.calendar, undefined);
});

test('a missing spend cap on an existing policy is refused rather than read as zero', () => {
  const p = policy();
  assert.throws(() => form.changesFor({ ...form.formFrom(p), spendCap: '' }, p), /Per-epoch spend cap is required/);
});

test('limiting recipients needs a spend cap first', () => {
  const p = policy({ spend: null });
  assert.throws(() => form.changesFor({ ...form.formFrom(p), enforce: true }, p), /Set a per-epoch spend cap/);
});

test('calendar caps need both values, and zero is accepted as a real cap', () => {
  const p = policy();
  assert.throws(() => form.changesFor({ ...form.formFrom(p), dayCap: '' }, p), /both the daily and weekly/);
  const zero = form.changesFor({ ...form.formFrom(p), dayCap: '0', weekCap: '0' }, p);
  assert.deepEqual(zero.calendar, { dayCapMist: 0n, weekCapMist: 0n });
});

test('bad amounts and an inverted daily/weekly pair are refused', () => {
  const p = policy();
  assert.throws(() => form.changesFor({ ...form.formFrom(p), perTx: 'lots' }, p), /must be an amount of SUI/);
  assert.throws(() => form.changesFor({ ...form.formFrom(p), perTx: '0' }, p), /must be a positive amount/);
  assert.throws(() => form.changesFor({ ...form.formFrom(p), dayCap: '2', weekCap: '1' }, p), /cannot exceed the weekly cap/);
});

test('validation refuses an address that is both added and removed', () => {
  assert.throws(
    () => owner.validatePolicyChanges({ allowRecipients: [friend], disallowRecipients: [friend] }),
    /both added and removed/,
  );
});

test('the on-chain policy reader decodes limits, caps, and recipients from the vault', async () => {
  const dynamicFields = [
    { fieldId: spendFieldId, $kind: 'DynamicField', name: { type: `${pkg}::spending_vault::SpendPolicyKey`, bcs: new Uint8Array() } },
    { fieldId: calendarFieldId, $kind: 'DynamicField', name: { type: `${pkg}::spending_vault::CalendarPolicyKey`, bcs: new Uint8Array() } },
    { fieldId: 'unused-1', $kind: 'DynamicField', name: { type: `${pkg}::spending_vault::AllowedRecipient`, bcs: addrBytes(friend) } },
    { fieldId: 'unused-2', $kind: 'DynamicField', name: { type: `${pkg}::spending_vault::BlockedRecipient`, bcs: addrBytes(other) } },
  ];
  const objects = {
    [vault]: { objectId: vault, json: { per_tx_limit: '100000000', paused: false } },
    [spendFieldId]: { objectId: spendFieldId, json: { value: { daily_cap: '200000000', enforce_recipients: true } } },
    [calendarFieldId]: { objectId: calendarFieldId, json: { value: { day_cap: '300000000', week_cap: '900000000' } } },
  };
  const reader = {
    async getObjects({ objectIds }) {
      return { objects: objectIds.map((id) => objects[id]) };
    },
    async listDynamicFields() {
      return { dynamicFields, hasNextPage: false, cursor: null };
    },
  };
  const read = await owner.readVaultPolicy(reader, vault);
  assert.equal(read.perTxLimitMist, 100_000_000n);
  assert.deepEqual(read.spend, { dailyCapMist: 200_000_000n, enforceRecipients: true });
  assert.deepEqual(read.calendar, { dayCapMist: 300_000_000n, weekCapMist: 900_000_000n });
  assert.deepEqual(read.allowedRecipients, [friend]);
});

test('display names are trimmed, bounded, and refused when empty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'profile-'));
  process.env.SUI_ACCOUNTS_DIR = dir;
  t.after(() => rm(dir, { recursive: true, force: true }));
  const accounts = loadTs('lib/server/accounts.ts');
  await accounts.createPendingAccount({ ownerAddress: `0x${'a'.repeat(64)}`, userId: 'sub-9' }, async () => `0x${'b'.repeat(64)}`);

  const saved = await accounts.updateDisplayName('sub-9', '  Jo  ');
  assert.equal(saved.displayName, 'Jo');
  await assert.rejects(accounts.updateDisplayName('sub-9', '   '), /1 to 60 characters/);
  await assert.rejects(accounts.updateDisplayName('sub-9', 'x'.repeat(61)), /1 to 60 characters/);
  await assert.rejects(accounts.updateDisplayName('someone-else', 'Jo'), /do not have an account/);
});
