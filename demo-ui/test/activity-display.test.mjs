import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

const activity = loadTs('lib/server/activity.ts');
const display = loadTs('lib/display.ts', { './sui': { explorerAddressUrl: (a) => `addr/${a}`, explorerTxUrl: (d) => `tx/${d}` } });
const addr = (c) => `0x${c.repeat(64)}`;
const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const account = { ownerAddress: addr('a'), agentAddress: addr('b'), vaultId: addr('c') };
const gas = { gasSummary: { computationCost: '1000', storageCost: '0', storageRebate: '0' } };
const tx = (sender, functions, changes) => ({
  digest: 'D1',
  sender: { address: sender },
  effects: {
    status: 'SUCCESS',
    timestamp: '2026-11-20T00:00:00Z',
    gasEffects: gas,
    balanceChanges: { nodes: changes.map(([owner, amount]) => ({ owner: { address: owner }, amount: String(amount), coinType: { repr: SUI } })) },
  },
  kind: { __typename: 'ProgrammableTransaction', commands: { nodes: functions.map((name) => ({ __typename: 'MoveCallCommand', function: { name, module: { name: 'spending_vault' } } })) } },
});

test('a vault payment by Cipher shows the amount and the labeled recipient', () => {
  const entry = activity.describeTransaction(tx(account.agentAddress, ['spend_with_clock'], [[account.agentAddress, -1000], [addr('d'), 50_000_000]]), account, { [addr('d')]: 'Friend' });
  assert.equal(entry.kind, 'payment');
  assert.equal(entry.by, 'cipher');
  assert.equal(entry.amountMist, '50000000');
  assert.deepEqual(entry.counterparty, { address: addr('d'), label: 'Friend' });
});

test('incoming funds and vault deposits are told apart, with gas excluded', () => {
  const received = activity.describeTransaction(tx(addr('e'), [], [[addr('e'), -2_000_000_000], [account.ownerAddress, 1_000_000_000]]), account);
  assert.equal(received.kind, 'received');
  assert.equal(received.direction, 'in');
  assert.equal(received.amountMist, '1000000000');
  const deposit = activity.describeTransaction(tx(account.ownerAddress, ['deposit'], [[account.ownerAddress, -500_001_000]]), account);
  assert.equal(deposit.kind, 'deposit');
  assert.equal(deposit.amountMist, '500000000');
});

test('tool text keeps every detail but shows labeled short addresses and a receipt link', () => {
  const digest = 'FCZ4mgKKBtF3WYYBtvQPndzBAw8kVXsVhjfBkHJF98tC';
  const lines = display.formatToolText(`Sent 0.05 SUI\nTo: ${addr('d')}\nDigest: ${digest}\nExplorer: https://suiscan.xyz/testnet/tx/${digest}`, { [addr('d')]: 'Friend' });
  assert.equal(lines.length, 3, 'the explorer line folds into the receipt');
  assert.deepEqual(lines[1][1], { kind: 'address', address: addr('d'), label: 'Friend' });
  assert.deepEqual(lines[2][1], { kind: 'receipt', digest });
  assert.equal(display.shortAddress(addr('d')), '0xdddd…dddd');
});
