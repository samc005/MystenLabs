import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
const source = readFileSync(new URL('../lib/server/passkey.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
function fixture() {
  const initial = { credentials: [{id:'owner',publicKey:'AA==',counter:0,label:'owner',createdAt:''}],revoked:false };
  const fs = {readFile:async()=>JSON.stringify(initial),mkdir:async()=>{},writeFile:async()=>{}};
  const webauthn = {
    generateAuthenticationOptions:async()=>({challenge:'challenge'}),
    verifyAuthenticationResponse:async options=>{assert.equal(options.requireUserVerification,true);return {verified:true,authenticationInfo:{newCounter:1}};},
    generateRegistrationOptions:async()=>({challenge:'enroll'}),
    verifyRegistrationResponse:async()=>({verified:true,registrationInfo:{credential:{id:'second',publicKey:Uint8Array.of(1),counter:0}}}),
  };
  const exports = {};
  new Function('require','exports',compiled)(name=>({'node:crypto':crypto,'node:fs/promises':fs,'node:path':path,'@simplewebauthn/server':webauthn}[name]),exports);
  return exports;
}
const request = new Request('http://localhost', {headers:{host:'localhost'}});
const hash = data=>crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
async function approve(api,digest) {
  const {challengeId} = await api.authenticationOptions(request,digest);
  return api.verifyAuthentication(request,challengeId,{id:'owner'});
}
test('approval is bound to its action and can be consumed once, including concurrent requests',async()=>{
  const api=fixture(), digest=hash({action:'wallet-command',command:'balance'});
  const {approvalId}=await approve(api,digest);
  await assert.rejects(api.consumeApproval(approvalId,hash({action:'wallet-command',command:'vault'})));
  const results=await Promise.allSettled([api.consumeApproval(approvalId,digest),api.consumeApproval(approvalId,digest)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('existing credential must authorize enrollment; transaction approval cannot enroll a device',async()=>{
  const api=fixture();
  await assert.rejects(api.registrationOptions(request),/existing passkey/);
  const unrelated=await approve(api,hash({action:'wallet-command',command:'balance'}));
  await assert.rejects(api.registrationOptions(request,unrelated.approvalId));
  const approved=await approve(api,hash({action:'register-passkey',network:'testnet'}));
  const {challengeId}=await api.registrationOptions(request,approved.approvalId);
  await api.verifyRegistration(request,challengeId,{response:{transports:[]}});
  assert.equal((await api.passkeyStatus()).credentialCount,2);
  await assert.rejects(api.registrationOptions(request,approved.approvalId));
});
