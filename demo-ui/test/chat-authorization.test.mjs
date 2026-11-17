import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../app/api/chat/route.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(locked=false) {
  const turns=[];
  const modules={
    '@/lib/server/passkey':{passkeyStatus:async()=>({revoked:locked})},
    '@anthropic-ai/sdk':{APIError:class extends Error{}},
    '@/lib/server/agent':{runChatTurn:async(messages)=>turns.push(messages)},
    '@/lib/server/local-only':{rejectNonLocal:()=>null},
    '@/lib/ndjson':{ndjsonResponse:async(fn)=>{await fn(()=>{},new AbortController().signal);return new Response('prepared');}},
  };
  const exports={};new Function('require','exports',compiled)(name=>{if(!(name in modules))throw new Error(name);return modules[name];},exports);
  return {...exports,turns};
}
const request=(content)=>new Request('http://localhost/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{role:'user',content}]})});
test('chat prepares without a passkey approval; execution remains a separate route',async()=>{
  const f=fixture();const response=await f.POST(request('balance'));
  assert.equal(response.status,200);assert.equal(f.turns.length,1);
});
test('application lock still prevents chat preparation',async()=>{
  const f=fixture(true);assert.equal((await f.POST(request('balance'))).status,403);assert.equal(f.turns.length,0);
});
test('malformed chat commands never dispatch',async()=>{
  const f=fixture();assert.equal((await f.POST(request('x'.repeat(2001)))).status,403);assert.equal(f.turns.length,0);
});
