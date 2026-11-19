import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

const { verifyAccountVault, AccountVerificationError } = loadTs('lib/server/account-verify.ts');
const addr = (c) => `0x${c.repeat(64)}`;
const pkg = addr('1'), vaultId = addr('2'), ownerCapId = addr('3'), agentCapId = addr('4');
const owner = addr('a'), agent = addr('b');
const account = { ownerAddress: owner, agentAddress: agent };
const claim = { vaultId, ownerCapId };

function chain(overrides = {}) {
  const objects = {
    [vaultId]: { type: `${pkg}::spending_vault::Vault`, json: { agent_version: '0' } },
    [ownerCapId]: { type: `${pkg}::spending_vault::OwnerCap`, owner: { AddressOwner: owner }, json: { vault_id: vaultId } },
    ...overrides.objects,
  };
  const agentCaps = overrides.agentCaps ?? [{ objectId: agentCapId, json: { vault_id: vaultId, version: '0' } }];
  return {
    getObject: async ({ objectId }) => ({ object: objects[objectId] }),
    listOwnedObjects: async ({ owner: who, type }) => ({
      objects: who === agent && type.endsWith('::AgentCap') ? agentCaps : [],
      hasNextPage: false,
      cursor: null,
    }),
  };
}

const verify = (reader, overrides = {}) => verifyAccountVault(reader, { packageId: pkg, account, claim, ...overrides });

test('accepts a vault from our package, owned by the account, with its agent authorized', async () => {
  assert.deepEqual(await verify(chain()), { packageId: pkg, vaultId, ownerCapId, agentCapId });
});

test('rejects a vault from any other package, even one with the same module name', async () => {
  await assert.rejects(
    verify(chain({ objects: { [vaultId]: { type: `${addr('9')}::spending_vault::Vault`, json: {} } } })),
    (e) => e instanceof AccountVerificationError && /vault package/.test(e.message),
  );
});

test('rejects an OwnerCap held by someone else', async () => {
  await assert.rejects(
    verify(chain({ objects: { [ownerCapId]: { type: `${pkg}::spending_vault::OwnerCap`, owner: { AddressOwner: addr('c') }, json: { vault_id: vaultId } } } })),
    /not held by this account/,
  );
});

test('rejects an OwnerCap that belongs to a different vault', async () => {
  await assert.rejects(
    verify(chain({ objects: { [ownerCapId]: { type: `${pkg}::spending_vault::OwnerCap`, owner: { AddressOwner: owner }, json: { vault_id: addr('d') } } } })),
    /different vault/,
  );
});

test('rejects when the agent was never authorized, or only holds a revoked generation', async () => {
  await assert.rejects(verify(chain({ agentCaps: [] })), /not been authorized/);
  await assert.rejects(
    verify(chain({ objects: { [vaultId]: { type: `${pkg}::spending_vault::Vault`, json: { agent_version: '1' } } } })),
    /not been authorized/,
  );
});

test('an agent cap for some other vault does not count', async () => {
  await assert.rejects(
    verify(chain({ agentCaps: [{ objectId: agentCapId, json: { vault_id: addr('e'), version: '0' } }] })),
    /not been authorized/,
  );
});
