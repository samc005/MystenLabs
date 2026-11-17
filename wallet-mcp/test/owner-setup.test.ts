import assert from 'node:assert/strict';
import {test} from 'node:test';
import {authorizeAgent,fundVault,type OwnerContext} from '../src/blockchain/owner.js';
import type {Transaction} from '@mysten/sui/transactions';
function fixture() {
  const transactions:Transaction[]=[];
  const result={$kind:'Transaction',Transaction:{digest:'fixture',events:[]}};
  const ctx={
    address:'0x'+'a'.repeat(64),ownerCapId:'0x'+'b'.repeat(64),network:'testnet',
    client:{
      signAndExecuteTransaction:async({transaction}:{transaction:Transaction})=>{transactions.push(transaction);return result;},
      waitForTransaction:async()=>result,
    },
  } as unknown as OwnerContext;
  return {ctx,transactions};
}
test('owner setup grants only through issue_agent_cap and deposits only into main vault',async()=>{
  const {ctx,transactions}=fixture();
  await authorizeAgent(ctx,'0x'+'c'.repeat(64));
  await fundVault(ctx,2_000_000_000n);
  const first=transactions[0]!.getData().commands.find(c=>c.MoveCall)?.MoveCall;
  const second=transactions[1]!.getData().commands.find(c=>c.MoveCall)?.MoveCall;
  assert.equal(first?.module,'spending_vault');assert.equal(first?.function,'issue_agent_cap');
  assert.equal(second?.module,'spending_vault');assert.equal(second?.function,'deposit');
});
test('owner setup rejects invalid recipients, nonpositive funding and non-testnet context before signing',async()=>{
  const {ctx,transactions}=fixture();
  await assert.rejects(authorizeAgent(ctx,'not-an-address'));
  await assert.rejects(fundVault(ctx,0n));
  await assert.rejects(fundVault(ctx,-1n));
  await assert.rejects(authorizeAgent({...ctx,network:'mainnet'},'0x'+'c'.repeat(64)));
  await assert.rejects(fundVault({...ctx,network:'mainnet'},1n));
  assert.equal(transactions.length,0);
});
