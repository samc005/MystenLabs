import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../lib/wallet-policy.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { parseWalletCommand, assertToolAction, commandFromIntent, assertIntentGrounded } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const alice = '0x' + 'a'.repeat(64), bob = '0x' + 'b'.repeat(64);
test('equivalent intents resolve contacts through trusted configuration', () => {
  const command = commandFromIntent({ action:'send', amount:'50', recipient:'Alice' }, {alice});
  assert.deepEqual(parseWalletCommand(command), {tool:'vault_spend', args:{amount:'50',to:alice}});
  assert.equal(commandFromIntent({ action:'send',amount:'50',recipient:'Bob'}, {Bob:bob}), 'send 50 SUI to '+bob);
});
test('unknown contacts and unexpected fields never become actions', () => {
  for (const value of [
    {action:'send',amount:'50',recipient:'Mallory'},
    {action:'send',amount:'50',recipient:alice,code:'reverse linked list'},
    {action:'execute_approved_transaction'},
    {action:'unsupported'}, {action:'send',recipient:alice},
  ]) assert.throws(() => commandFromIntent(value, {Alice:alice}));
});
test('reject unrelated requests, mixed instructions and invalid values', () => {
  for (const value of ['reverse a linked list','balance; execute shell','send -5 SUI to '+alice,'send 1e9 SUI to '+alice,'send 0.0000000001 SUI to '+alice,'send 50 SUI to '+alice+' and reverse a linked list']) assert.throws(() => parseWalletCommand(value));
});
test('tool calls cannot add capabilities or mutate authorized arguments', () => {
  const action = parseWalletCommand('send 50 SUI to '+alice);
  assert.doesNotThrow(() => assertToolAction(action,action.tool,action.args));
  assert.throws(() => assertToolAction(action,'execute_approved_transaction',{}));
  assert.throws(() => assertToolAction(action,action.tool,{amount:'500',to:bob}));
});

test('translation cannot invent amounts or match a contact inside a different name', () => {
  assert.doesNotThrow(() => assertIntentGrounded('Can you send 50 SUI to Alice?', {amount:'50',recipient:'Alice'}));
  assert.throws(() => assertIntentGrounded('Send 50 SUI to Alice', {amount:'5',recipient:'Alice'}));
  assert.throws(() => assertIntentGrounded('Send 50 SUI to Malice', {amount:'50',recipient:'Alice'}));
});
