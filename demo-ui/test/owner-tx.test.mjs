import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

const owner = loadTs('lib/owner-tx.ts');
const pkg = `0x${'1'.repeat(64)}`;
const vault = `0x${'2'.repeat(64)}`;
const cap = `0x${'3'.repeat(64)}`;
const agent = `0x${'4'.repeat(64)}`;
const friend = `0x${'5'.repeat(64)}`;

const moveCalls = (tx) => tx.getData().commands.filter((c) => c.$kind === 'MoveCall').map((c) => c.MoveCall.function);

test('create transaction only calls create_secure with the per-transaction limit', () => {
  const tx = owner.buildCreateVaultTx(pkg, 100_000_000n);
  const [command] = tx.getData().commands;
  assert.equal(tx.getData().commands.length, 1);
  assert.equal(command.MoveCall.module, 'spending_vault');
  assert.equal(command.MoveCall.function, 'create_secure');
});

test('setup is one atomic transaction that enables the agent last', () => {
  const tx = owner.buildSetupTx({
    packageId: pkg, vaultId: vault, ownerCapId: cap, agentAddress: agent,
    policy: { ...owner.DEFAULT_ONBOARDING_POLICY, allowedRecipients: [friend, friend.toUpperCase().replace('0X', '0x')] },
  });
  assert.deepEqual(moveCalls(tx), [
    'issue_agent_cap', 'set_spend_policy', 'set_calendar_policy', 'allow_recipient', 'deposit', 'set_agent_security_policy',
  ]);
  assert(tx.getData().commands.some((c) => c.$kind === 'TransferObjects'), 'agent gas is sent to the agent');
});

test('setup never calls an owner function beyond the onboarding set', () => {
  const tx = owner.buildSetupTx({ packageId: pkg, vaultId: vault, ownerCapId: cap, agentAddress: agent, policy: owner.DEFAULT_ONBOARDING_POLICY });
  const allowed = new Set(['issue_agent_cap', 'set_spend_policy', 'set_calendar_policy', 'allow_recipient', 'deposit', 'set_agent_security_policy']);
  for (const name of moveCalls(tx)) assert(allowed.has(name), name);
});

test('policy validation rejects unsafe or malformed input and normalizes recipients', () => {
  const base = owner.DEFAULT_ONBOARDING_POLICY;
  assert.throws(() => owner.validatePolicy({ ...base, depositMist: 0n }), /Vault deposit/);
  assert.throws(() => owner.validatePolicy({ ...base, dayCapMist: base.weekCapMist + 1n }), /daily cap/);
  assert.throws(() => owner.validatePolicy({ ...base, allowedRecipients: ['0x123'] }), /not a valid Sui address/);
  assert.throws(() => owner.validatePolicy({ ...base, allowedRecipients: Array.from({ length: 21 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, '0')}`) }), /at most/);
  const valid = owner.validatePolicy({ ...base, allowedRecipients: [` ${friend} `, friend] });
  assert.deepEqual(valid.allowedRecipients, [friend]);
});

test('required balance covers deposit, agent gas and fees', () => {
  const p = owner.DEFAULT_ONBOARDING_POLICY;
  assert(owner.requiredOwnerBalanceMist(p) > p.depositMist + p.agentGasMist);
});

function reader(pages) {
  return {
    getObject: async () => { throw new Error('unused'); },
    listOwnedObjects: async ({ cursor }) => {
      const index = cursor ? Number(cursor) : 0;
      return { objects: pages[index], hasNextPage: index < pages.length - 1, cursor: String(index + 1) };
    },
  };
}

test('findOwnerCap pages through results and skips vaults already registered', async () => {
  const r = reader([[{ objectId: cap, json: { vault_id: vault } }], [{ objectId: `0x${'6'.repeat(64)}`, json: { vault_id: `0x${'7'.repeat(64)}` } }]]);
  assert.deepEqual(await owner.findOwnerCap(r, friend, pkg), { ownerCapId: cap, vaultId: vault });
  assert.deepEqual((await owner.findOwnerCap(r, friend, pkg, [vault])).vaultId, `0x${'7'.repeat(64)}`);
  assert.equal(await owner.findOwnerCap(r, friend, pkg, [vault, `0x${'7'.repeat(64)}`]), undefined);
});

test('findAgentCap ignores caps from a rotated-out generation', async () => {
  const r = reader([[{ objectId: cap, json: { vault_id: vault, version: '0' } }, { objectId: agent, json: { vault_id: vault, version: '1' } }]]);
  assert.equal((await owner.findAgentCap(r, agent, pkg, vault)).agentCapId, cap);
  assert.equal((await owner.findAgentCap(r, agent, pkg, vault, 1)).agentCapId, agent);
  assert.equal(await owner.findAgentCap(r, agent, pkg, vault, 2), undefined);
});
