import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs } from './load-ts.mjs';

async function fresh(t) {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  process.env.SUI_ACCOUNTS_DIR = dir;
  t.after(() => rm(dir, { recursive: true, force: true }));
  return loadTs('lib/server/usage.ts');
}

const DAY = Date.UTC(2026, 10, 19, 12);
const NEXT_DAY = Date.UTC(2026, 10, 20, 0, 0, 1);

test('an account gets its daily allowance and no more; others are unaffected', async (t) => {
  const usage = await fresh(t);
  const limits = { account: 3, global: 100 };
  assert.equal((await usage.consumeDaily('a', limits, DAY)).remaining, 2);
  await usage.consumeDaily('a', limits, DAY);
  assert.equal((await usage.consumeDaily('a', limits, DAY)).remaining, 0);
  await assert.rejects(usage.consumeDaily('a', limits, DAY), (e) => e instanceof usage.LimitError && e.scope === 'account' && /resets at 00:00 UTC/.test(e.message));
  assert.equal((await usage.consumeDaily('b', limits, DAY)).remaining, 2);
});

test('the global ceiling stops many accounts adding up', async (t) => {
  const usage = await fresh(t);
  const limits = { account: 10, global: 3 };
  for (const id of ['a', 'b', 'c']) await usage.consumeDaily(id, limits, DAY);
  await assert.rejects(usage.consumeDaily('d', limits, DAY), (e) => e.scope === 'global');
});

test('a refused request is not counted', async (t) => {
  const usage = await fresh(t);
  const limits = { account: 1, global: 100 };
  await usage.consumeDaily('a', limits, DAY);
  await assert.rejects(usage.consumeDaily('a', limits, DAY));
  await assert.rejects(usage.consumeDaily('a', limits, DAY));
  assert.equal((await usage.consumeDaily('a', { account: 2, global: 100 }, DAY)).remaining, 0);
});

test('the allowance resets at the next UTC day', async (t) => {
  const usage = await fresh(t);
  const limits = { account: 1, global: 100 };
  await usage.consumeDaily('a', limits, DAY);
  await assert.rejects(usage.consumeDaily('a', limits, DAY));
  assert.equal((await usage.consumeDaily('a', limits, NEXT_DAY)).remaining, 0);
});

test('counts survive a restart, so restarting cannot reset the budget', async (t) => {
  const first = await fresh(t);
  const limits = { account: 1, global: 100 };
  await first.consumeDaily('a', limits, DAY);
  const restarted = loadTs('lib/server/usage.ts');
  await assert.rejects(restarted.consumeDaily('a', limits, DAY), /Daily chat limit/);
});

test('concurrent requests cannot overshoot the limit', async (t) => {
  const usage = await fresh(t);
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => usage.consumeDaily('a', { account: 5, global: 100 }, DAY)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5);
});

test('limits come from the environment, falling back on anything invalid', async (t) => {
  const usage = await fresh(t);
  assert.deepEqual(usage.limitsFromEnv({}), { account: 50, global: 1000 });
  assert.deepEqual(usage.limitsFromEnv({ CHAT_DAILY_LIMIT: '7', CHAT_GLOBAL_DAILY_LIMIT: '20' }), { account: 7, global: 20 });
  assert.deepEqual(usage.limitsFromEnv({ CHAT_DAILY_LIMIT: '0', CHAT_GLOBAL_DAILY_LIMIT: 'lots' }), { account: 50, global: 1000 });
  assert.deepEqual(usage.limitsFromEnv({ CHAT_DAILY_LIMIT: '-3' }), { account: 50, global: 1000 });
});
