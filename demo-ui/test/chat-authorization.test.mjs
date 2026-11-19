import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../app/api/chat/route.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const ACCOUNT={accountId:'acct-1',vaultId:'0xvault'};
class AccountError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
class LimitError extends Error{}
function fixture({locked=false,session=true,hasAccount=true,limited=false}={}) {
  const turns=[],accounts=[],consumed=[];
  const modules={
    '@/lib/server/passkey':{passkeyStatus:async()=>({revoked:locked})},
    '@anthropic-ai/sdk':{APIError:class extends Error{}},
    '@/lib/server/agent':{runChatTurn:async(messages,_send,_signal,account)=>{turns.push(messages);accounts.push(account);}},
    '@/lib/server/account-context':{
      AccountError,
      requireAccount:async()=>{
        if(!session)throw new AccountError(401,'sign_in','Sign in with Google first.');
        if(!hasAccount)throw new AccountError(403,'no_account','Create your account first.');
        return ACCOUNT;
      },
      accountErrorResponse:(e)=>e instanceof AccountError?Response.json({error:e.message,code:e.code},{status:e.status}):null,
    },
    '@/lib/server/usage':{
      LimitError,
      limitsFromEnv:()=>({account:50,global:1000}),
      consumeDaily:async(id)=>{consumed.push(id);if(limited)throw new LimitError('Daily chat limit reached.');return {remaining:1};},
    },
    '@/lib/server/local-only':{rejectNonLocal:()=>null},
    '@/lib/ndjson':{ndjsonResponse:async(fn)=>{await fn(()=>{},new AbortController().signal);return new Response('prepared');}},
  };
  const exports={};new Function('require','exports',compiled)(name=>{if(!(name in modules))throw new Error(name);return modules[name];},exports);
  return {...exports,turns,accounts,consumed};
}
const request=(content)=>new Request('http://localhost/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{role:'user',content}]})});
test('chat prepares without a passkey approval; execution remains a separate route',async()=>{
  const f=fixture();const response=await f.POST(request('balance'));
  assert.equal(response.status,200);assert.equal(f.turns.length,1);
});
test('application lock still prevents chat preparation',async()=>{
  const f=fixture({locked:true});assert.equal((await f.POST(request('balance'))).status,403);assert.equal(f.turns.length,0);
});
test('malformed chat commands never dispatch',async()=>{
  const f=fixture();assert.equal((await f.POST(request('x'.repeat(2001)))).status,403);assert.equal(f.turns.length,0);
});
test('signed-out visitors and users without an account never reach Claude or the wallet',async()=>{
  const out=fixture({session:false}),response=await out.POST(request('balance'));
  assert.equal(response.status,401);assert.equal((await response.json()).code,'sign_in');
  const none=fixture({hasAccount:false}),refused=await none.POST(request('balance'));
  assert.equal(refused.status,403);assert.equal((await refused.json()).code,'no_account');
  for(const f of [out,none]){assert.equal(f.turns.length,0);assert.equal(f.consumed.length,0);}
});
test('the turn runs for the signed-in account, and spends that account\'s allowance',async()=>{
  const f=fixture();await f.POST(request('balance'));
  assert.deepEqual(f.accounts,[ACCOUNT]);assert.deepEqual(f.consumed,[ACCOUNT.accountId]);
});
test('over the daily limit is a 429 and nothing runs',async()=>{
  const f=fixture({limited:true}),response=await f.POST(request('balance'));
  assert.equal(response.status,429);assert.equal((await response.json()).code,'rate_limited');assert.equal(f.turns.length,0);
});
test('invalid or locked requests do not spend the allowance',async()=>{
  const bad=fixture();await bad.POST(request('x'.repeat(2001)));
  const locked=fixture({locked:true});await locked.POST(request('balance'));
  assert.equal(bad.consumed.length,0);assert.equal(locked.consumed.length,0);
});
