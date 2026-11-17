import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compiled=ts.transpileModule(readFileSync(new URL('../lib/passkey.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
for (const registered of [false,true]) test(`proposal approval enrolls only when needed (registered=${registered})`,async()=>{
  const calls=[];const original=globalThis.fetch;const hash='a'.repeat(64);
  globalThis.fetch=async(url)=>{
    calls.push(url);
    const data=url.endsWith('/status')?{registered}:url.endsWith('/options')?{challengeId:'challenge',options:{}}:url.endsWith('/auth/verify')?{approvalId:'approved',proposalHash:hash}:{};
    return new Response(JSON.stringify(data),{status:200});
  };
  try {
    const exports={};new Function('require','exports',compiled)(()=>({startRegistration:async()=>({}),startAuthentication:async()=>({})}),exports);
    assert.deepEqual(await exports.approveProposalWithEnrollment(hash),{approvalId:'approved'});
    assert.equal(calls.includes('/api/passkey/register/verify'),!registered);
    assert.equal(calls.at(-1),'/api/passkey/auth/verify');
    if(!registered) assert.ok(calls.indexOf('/api/passkey/register/verify')<calls.indexOf('/api/passkey/auth/options'));
  } finally {globalThis.fetch=original;}
});
