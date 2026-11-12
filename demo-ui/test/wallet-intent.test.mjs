import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const policy={};new Function('exports',compile(readFileSync(new URL('../lib/wallet-policy.ts',import.meta.url),'utf8')))(policy);
function fixture(content) {
  const requests=[];
  class Anthropic {messages={create:async request=>{requests.push(request);return {content};}};}
  const exports={};
  new Function('require','exports',compile(readFileSync(new URL('../lib/server/wallet-intent.ts',import.meta.url),'utf8')))(name=>name==='@anthropic-ai/sdk'?Anthropic:policy,exports);
  return {...exports,requests};
}
test('translator uses automatic tool choice supported by the configured model',async()=>{
  const f=fixture([{type:'tool_use',name:'wallet_intent',input:{action:'balance'}}]);
  assert.equal(await f.resolveWalletCommand('Please check my balance',new AbortController().signal),'balance');
  assert.deepEqual(f.requests[0].tool_choice,{type:'auto'});
});
test('automatic choice still fails closed on prose, wrong tool, or multiple calls',async()=>{
  for(const content of [
    [{type:'text',text:'Here is arbitrary code'}],
    [{type:'tool_use',name:'shell',input:{}}],
    [1,2].map(()=>({type:'tool_use',name:'wallet_intent',input:{action:'balance'}})),
  ])await assert.rejects(fixture(content).resolveWalletCommand('Please check my balance',new AbortController().signal),/No valid wallet intent/);
});
