import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs } from './load-ts.mjs';

let spawned = 0;
const proposals = loadTs('lib/server/proposals.ts', {
  '@/lib/proposals': { PROPOSAL_ID: /^prop_[0-9a-f]{10}$/, isSpendProposal: (p) => p.kind === 'spend' },
  './wallet-mcp': { walletMcpDir: () => '/nonexistent' },
  'node:child_process': { spawn: () => { spawned++; throw new Error('must not spawn'); } },
});

const PENDING = (id, extra = {}) => ({ id, status: 'pending', kind: 'spend', createdAtMs: 1, approvalDeadlineMs: Date.now() + 60_000, ...extra });
async function dirWith(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'proposals-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, `${name}.json`), JSON.stringify(body));
  return dir;
}

test('an account sees only the proposals in its own directory', async (t) => {
  const mine = await dirWith(t, { prop_aaaaaaaaaa: PENDING('prop_aaaaaaaaaa') });
  const theirs = await dirWith(t, { prop_bbbbbbbbbb: PENDING('prop_bbbbbbbbbb') });
  assert.deepEqual((await proposals.listProposals(mine)).map((p) => p.id), ['prop_aaaaaaaaaa']);
  assert.deepEqual((await proposals.listProposals(theirs)).map((p) => p.id), ['prop_bbbbbbbbbb']);
  assert.equal(await proposals.readProposal('prop_bbbbbbbbbb', mine), undefined);
  assert.deepEqual(await proposals.listProposals(join(mine, 'missing')), []);
});

test('proposal ids that are not proposal ids never touch the filesystem', async (t) => {
  const dir = await dirWith(t, {});
  for (const bad of ['../secret', 'prop_../../x', 'PROP_AAAAAAAAAA', '']) {
    assert.equal(await proposals.readProposal(bad, dir), undefined);
  }
});

test('approve is refused without spawning anything, and never reads a key', async (t) => {
  const dir = await dirWith(t, { prop_aaaaaaaaaa: PENDING('prop_aaaaaaaaaa') });
  const result = await proposals.decideProposal('prop_aaaaaaaaaa', 'approve', { accountId: 'a', proposalsDir: dir });
  assert.equal(result.ok, false);
  assert.equal(result.status, 501);
  assert.equal(result.error, proposals.APPROVE_UNAVAILABLE);
  assert.equal(spawned, 0);
});

test('rejecting an unknown or already-decided proposal fails before anything runs', async (t) => {
  const dir = await dirWith(t, { prop_aaaaaaaaaa: PENDING('prop_aaaaaaaaaa', { status: 'approved' }) });
  const account = { accountId: 'a', proposalsDir: dir };
  assert.equal((await proposals.decideProposal('prop_cccccccccc', 'reject', account)).status, 404);
  assert.equal((await proposals.decideProposal('prop_aaaaaaaaaa', 'reject', account)).status, 409);
  assert.equal((await proposals.decideProposal('nope', 'reject', account)).status, 400);
  assert.equal(spawned, 0);
});

test('execution is recorded in the directory it is given, and only for a matching proposal', async (t) => {
  const mine = await dirWith(t, { prop_aaaaaaaaaa: PENDING('prop_aaaaaaaaaa') });
  const theirs = await dirWith(t, {});
  await assert.rejects(proposals.recordProposalExecution('prop_aaaaaaaaaa', 'payment', 'digest', theirs), /mismatch/);
  await assert.rejects(proposals.recordProposalExecution('prop_aaaaaaaaaa', 'swap', 'digest', mine), /mismatch/);
  await proposals.recordProposalExecution('prop_aaaaaaaaaa', 'payment', 'digest-1', mine);
  const stored = JSON.parse(await readFile(join(mine, 'prop_aaaaaaaaaa.json'), 'utf8'));
  assert.equal(stored.status, 'executed');
  assert.equal(stored.spendDigest, 'digest-1');
});
