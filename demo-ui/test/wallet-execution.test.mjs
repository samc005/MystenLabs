import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
const source=readFileSync(new URL('../lib/server/wallet-execution.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
function fixture({failedSimulation=false,locked=false,confirmed=false,onConnect=()=>{}}={}) {
  const writes=[], calls=[], updates=[], approvals=new Set();
  const consumeApproval=async(id,hash)=>{if(!approvals.delete(id+hash))throw new Error('Invalid or replayed approval');};
  const mcp={callTool:async input=>{calls.push(input);return {isError:input.name==='estimate_gas'&&failedSimulation,content:[],structuredContent: input.name==='execute_approved_transaction'&&confirmed?{confirmed:true,digest:'confirmed-digest'}:undefined};},close:async()=>{}};
  const exports={};
  const fs={stat:async()=>({isDirectory:()=>true,mode:0o700,uid:process.getuid()}),mkdir:async()=>{},writeFile:async(p,body)=>writes.push(JSON.parse(body)),rename:async()=>{}};
  const modules={'node:crypto':crypto,'node:fs/promises':fs,'node:path':path,'./passkey':{consumeApproval,passkeyStatus:async()=>({revoked:locked})},'./agent':{connectWalletMcp:async(account)=>{onConnect(account);return mcp;}},'./proposals':{recordProposalExecution:async(...args)=>updates.push(args)}};
  new Function('require','exports',compiled)(name=>modules[name],exports);
  return {...exports,writes,calls,updates,approve(id,command){const hash=crypto.createHash('sha256').update(JSON.stringify({action:'execute-wallet-command',id,command,summary:""})).digest('hex');approvals.add('approval'+hash);}};
}
process.env.SUI_SIGNER_STATE_DIR='/private/test-fixture';
const ACCOUNT={accountId:'acct-1',proposalsDir:'/tmp/acct-1/proposals'};
const OTHER={accountId:'acct-2',proposalsDir:'/tmp/acct-2/proposals'};
test('execution simulates and publishes only the server-stored bytes; concurrent replay fails',async()=>{
  const f=fixture(),command='send 0.01 SUI to Alice',bytes='trusted-built-bytes';
  const id=f.rememberPrepared(ACCOUNT.accountId,command,bytes);f.approve(id,command);
  const outcomes=await Promise.allSettled([f.executePrepared(ACCOUNT,id,'approval'),f.executePrepared(ACCOUNT,id,'approval')]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].transactionBytes,bytes);
  assert.deepEqual(f.calls.map(x=>x.name),['estimate_gas','execute_approved_transaction']);
  assert.equal(f.calls[1].arguments.transactionBytes,bytes);
  await assert.rejects(f.executePrepared(ACCOUNT,id,'approval'));
});
test('another account cannot execute my transaction, and the refusal burns nothing',async()=>{
  const f=fixture(),command='send 0.01 SUI to Alice',id=f.rememberPrepared(ACCOUNT.accountId,command,'my-bytes');
  f.approve(id,command);
  await assert.rejects(f.executePrepared(OTHER,id,'approval'),/missing, used, or expired/);
  assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
  // The approval was not consumed by the foreign attempt, so the real owner can still use it.
  await f.executePrepared(ACCOUNT,id,'approval');
  assert.equal(f.writes.length,1);
});
test('the MCP server is started for the account that executes',async()=>{
  const seen=[];
  const f=fixture({onConnect:a=>seen.push(a)}),command='send 0.01 SUI to Alice',id=f.rememberPrepared(ACCOUNT.accountId,command,'b');
  f.approve(id,command);await f.executePrepared(ACCOUNT,id,'approval');
  assert.deepEqual(seen,[ACCOUNT]);
});
test('failed simulation, lock, unknown transaction and mismatched approval never publish signing authority',async()=>{
  for(const options of [{failedSimulation:true},{locked:true},{}]) {
    const f=fixture(options),command='stake 1 SUI with validator',id=f.rememberPrepared(ACCOUNT.accountId,command,'bytes');
    if(options.failedSimulation||options.locked)f.approve(id,command);
    await assert.rejects(f.executePrepared(ACCOUNT,id,'approval'));
    await assert.rejects(f.executePrepared(ACCOUNT,'client-invented-id','approval'));
    assert.equal(f.writes.length,0);
    assert.equal(f.calls.some(x=>x.name==='execute_approved_transaction'),false);
  }
});

test('proposal cards are marked executed only after checkpoint confirmation',async()=>{
  for(const confirmed of [false,true]) {
    const f=fixture({confirmed}),command='execute swap prop_1234567890';
    const id=f.rememberPrepared(ACCOUNT.accountId,command,'built-bytes');f.approve(id,command);
    await f.executePrepared(ACCOUNT,id,'approval');
    assert.equal(f.updates.length,confirmed?1:0);
    // The card is updated in this account's own proposals directory, never another's.
    if(confirmed)assert.deepEqual(f.updates[0],['prop_1234567890','swap','confirmed-digest',ACCOUNT.proposalsDir]);
  }
});
