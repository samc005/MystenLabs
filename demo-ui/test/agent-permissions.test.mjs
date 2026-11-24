import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

const perms = loadTs('lib/agent-permissions.ts');
const owner = loadTs('lib/owner-tx.ts');
const policyLib = loadTs('lib/wallet-policy.ts');
const addr = (c) => `0x${c.repeat(64)}`;
const vault = { packageId: addr('a'), vaultId: addr('b'), ownerCapId: addr('c') };
const V1 = addr('1');
const V2 = addr('2');
const NOW = 1_700_000_000_000;
const empty = { perTxLimitMist: 1n, spend: null, calendar: null, allowedRecipients: [], agent: { payments: true, staking: false, trading: false }, allowedValidators: [], balanceMist: 1_000_000_000n };
const calls = (tx) => tx.getData().commands.filter((c) => c.MoveCall).map((c) => c.MoveCall);

test('turning on staking and swaps is one owner transaction, switches last', () => {
  const form = { ...perms.permissionsFormFrom(empty), staking: true, validators: [V1], trading: true, addToTrading: '0.25' };
  const changes = perms.permissionChanges(form, empty, NOW);
  const moves = calls(perms.buildAgentPermissionsTx(changes, vault));
  assert.deepEqual(moves.map((m) => m.function), ['set_stake_policy', 'allow_validator', 'set_trade_rule', 'allocate_sui_to_trading', 'set_agent_security_policy']);
  const rule = moves.find((m) => m.function === 'set_trade_rule');
  assert.equal(rule.typeArguments[0].endsWith('::sui::SUI'), true);
  assert.equal(rule.typeArguments[1], perms.TUSDC_TYPE);
  // 1.9 tUSDC per SUI: min_out micro-tUSDC >= amount MIST * 1_900_000 / 1e9.
  assert.equal(changes.swapRule.rateNum, 1_900_000n);
  assert.equal(changes.swapRule.rateDen, 1_000_000_000n);
  assert.equal(changes.swapRule.expiryMs, BigInt(NOW + 30 * 86_400_000));
  assert.equal(changes.addToTradingMist, 250_000_000n);
  assert.deepEqual([changes.payments, changes.staking, changes.trading], [true, true, true]);
});

test('turning things off flips only the switches and keeps validators for later', () => {
  const on = { ...empty, agent: { payments: true, staking: true, trading: true }, allowedValidators: [V1] };
  const changes = perms.permissionChanges({ ...perms.permissionsFormFrom(on), staking: false, trading: false }, on, NOW);
  assert.deepEqual(calls(perms.buildAgentPermissionsTx(changes, vault)).map((m) => m.function), ['set_agent_security_policy']);
  // Swapping one validator for another removes only the old one.
  const swap = perms.permissionChanges({ ...perms.permissionsFormFrom(on), validators: [V2] }, on, NOW);
  assert.deepEqual([swap.allowValidators, swap.disallowValidators], [[V2], [V1]]);
});

test('bad limits are refused with a readable reason before anything is signed', () => {
  const base = { ...perms.permissionsFormFrom(empty), staking: true, validators: [V1] };
  assert.throws(() => perms.permissionChanges({ ...base, validators: [] }, empty), /at least one validator/);
  assert.throws(() => perms.permissionChanges({ ...base, maxStaked: '0.5' }, empty), /at least 1 SUI/);
  assert.throws(() => perms.permissionChanges({ ...base, maxPositions: '0' }, empty), /whole number/);
  const trade = { ...perms.permissionsFormFrom(empty), trading: true };
  assert.throws(() => perms.permissionChanges({ ...trade, maxPerDay: '0.1', maxPerSwap: '0.5' }, empty), /at least the most per swap/);
  assert.throws(() => perms.permissionChanges({ ...trade, minUsdcPerSui: 'cheap' }, empty), /Worst price/);
  assert.throws(() => perms.permissionChanges({ ...trade, addToTrading: '2' }, empty), /vault holds 1 SUI/);
});

test('the policy reader decodes staking, validators, the swap rule and the trading balance', async () => {
  const pkg = addr('a');
  const usdc = `${addr('9')}::test_usdc::TEST_USDC`;
  const bytes = (a) => Uint8Array.from(Buffer.from(a.slice(2), 'hex'));
  const dynamicFields = [
    { fieldId: 'f-agent', name: { type: `${pkg}::spending_vault::AgentSecurityPolicyKey`, bcs: new Uint8Array() } },
    { fieldId: 'f-stake', name: { type: `${pkg}::spending_vault::StakePolicyKey`, bcs: new Uint8Array() } },
    { fieldId: 'x', name: { type: `${pkg}::spending_vault::AllowedValidator`, bcs: bytes(V1) } },
    { fieldId: 'f-rule', name: { type: `${pkg}::spending_vault::TradeRuleKey<0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI, ${usdc}>`, bcs: new Uint8Array() } },
    { fieldId: 'f-back', name: { type: `${pkg}::spending_vault::TradeRuleKey<${usdc}, 0x2::sui::SUI>`, bcs: new Uint8Array() } },
    { fieldId: 'f-sleeve', name: { type: `${pkg}::spending_vault::TradingKey<0x2::sui::SUI>`, bcs: new Uint8Array() } },
  ];
  const objects = {
    [vault.vaultId]: { objectId: vault.vaultId, json: { per_tx_limit: '5', balance: '700' } },
    'f-agent': { objectId: 'f-agent', json: { value: { payments: true, staking: true, trading: false } } },
    'f-stake': { objectId: 'f-stake', json: { value: { max_staked: '2000000000', min_reserve: '1', max_positions: '3', staked_total: '1000000000', positions: '1' } } },
    'f-rule': { objectId: 'f-rule', json: { value: { max_per_trade: '10', max_per_epoch: '20', rate_num: '1900000', rate_den: '1000000000', expiry_ms: '99' } } },
    'f-sleeve': { objectId: 'f-sleeve', json: { value: { value: '42' } } },
  };
  const reader = {
    async getObjects({ objectIds }) { return { objects: objectIds.map((id) => objects[id] ?? new Error('unexpected read ' + id)) }; },
    async listDynamicFields() { return { dynamicFields, hasNextPage: false, cursor: null }; },
  };
  const read = await owner.readVaultPolicy(reader, vault.vaultId);
  assert.deepEqual(read.agent, { payments: true, staking: true, trading: false });
  assert.equal(read.stake.stakedMist, 1_000_000_000n);
  assert.deepEqual(read.allowedValidators, [V1]);
  assert.deepEqual(read.swapRule, { maxPerTradeMist: 10n, maxPerEpochMist: 20n, rateNum: 1_900_000n, rateDen: 1_000_000_000n, expiryMs: 99 });
  assert.equal(read.tradingSuiMist, 42n);
  assert.equal(read.balanceMist, 700n);
  assert.equal(perms.permissionsFormFrom(read).minUsdcPerSui, '1.9');
});

test('chat can stake with an approved validator by name, never an unapproved one', () => {
  const validators = { 'Mysten-5': V1 };
  assert.equal(policyLib.commandFromIntent({ action: 'stake', amount: '1', validator: 'mysten-5' }, {}, validators), `stake 1 SUI with ${V1}`);
  assert.throws(() => policyLib.commandFromIntent({ action: 'stake', amount: '1', validator: 'Random Node' }, {}, validators), /validators you let Cipher stake with/);
});

test('a swap covered by the standing rule is recognized for a same-turn passkey confirm', () => {
  const agent = loadTs('lib/server/agent.ts', {
    './wallet-intent': {}, './account-context': {}, './wallet-mcp': {}, './account-store': {}, './local-actions': {}, './wallet-execution': {},
    './chat-presenter': {}, '@/lib/owner-tx': {}, '@/lib/sui': {}, './validators': {}, '@/lib/wallet-policy': {},
    '@modelcontextprotocol/client': { Client: class {} }, '@modelcontextprotocol/client/stdio': { getDefaultEnvironment: () => ({}), StdioClientTransport: class {} },
  });
  const covered = "Proposal ID: prop_0123456789\n...\n\nNothing has been traded yet, but the owner's standing trade rule already covers this swap, so no approval is needed.";
  assert.equal(agent.autoSwapProposal(covered), 'prop_0123456789');
  assert.equal(agent.autoSwapProposal('Proposal ID: prop_0123456789\nThe owner must approve this proposal in the app.'), null);
});

test('wallet refusals reach chat in plain words, never naming internal tools', () => {
  const presenter = loadTs('lib/server/chat-presenter.ts', {
    '@/lib/sui': { formatSui: () => '0', getAllBalances: async () => [], createSuiClient: () => ({}) },
    '@/lib/owner-tx': {},
    './wallet-mcp': {},
  });
  const jovia = addr('4');
  const say = (text) => presenter.friendlyRefusal(text, { [jovia]: 'Jovia' });
  const leaks = /propose_|vault_|npm run|\bcall\b|proposal/i;
  const cases = [
    'Error: This payment is outside the spending policy: Mandatory on-chain payment policy is not configured. Nothing was sent. It needs the owner\'s approval: call propose_spend, then wait for them to approve it.',
    `This payment is outside the spending policy: ${jovia} is not on the vault's recipient allowlist. Nothing was sent. It needs the owner's approval: call propose_spend, then wait for them to approve it.`,
    "Over the vault's per-spend limit. Requested 20 SUI, limit is 10 SUI. Larger payments need the owner's approval: call propose_spend instead.",
    'The trading sleeve holds 0 SUI, less than 1 SUI. The owner must allocate funds to the sleeve first (npm run owner -- allocate <amount>).',
    'Something new went wrong. Run it with vault_spend_approved instead.',
  ];
  for (const text of cases) assert.doesNotMatch(say(text), leaks, text);
  assert.match(say(cases[0]), /Only pay trusted recipients directly/);
  assert.match(say(cases[1]), /^Jovia isn't a trusted recipient/);
  assert.match(say(cases[2]), /per-payment limit of 10 SUI/);
  assert.equal(say(cases[4]), 'Something new went wrong.');
});
