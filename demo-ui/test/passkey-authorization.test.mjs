import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
const source = readFileSync(new URL('../lib/server/passkey.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
function fixture(readError, raw, options = {}) {
  const initial = { credentials: [{id:'owner',publicKey:'AA==',counter:0,label:'owner',createdAt:''}],revoked:false };
  const files = new Map([['credentials.json', raw ?? JSON.stringify(initial)]]);
  if (options.recoveryCode) files.set('recovery.json', JSON.stringify({
    hash: crypto.createHash('sha256').update(options.recoveryCode).digest('hex'),
    expiresAt: options.expiresAt ?? Date.now() + 60_000,
  }));
  const fs = {
    readFile: async name => {
      if (readError) throw readError;
      const value = files.get(path.basename(name));
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return value;
    },
    mkdir: async()=>{},
    writeFile: async(name, value)=>{ files.set(path.basename(name), value); },
    rename: async(from, to)=>{
      const name=path.basename(from), value=files.get(name);
      if (value === undefined) throw Object.assign(new Error('missing'), {code:'ENOENT'});
      files.set(path.basename(to), value); files.delete(name);
    },
  };
  const webauthn = {
    generateAuthenticationOptions:async()=>({challenge:'challenge'}),
    verifyAuthenticationResponse:async input=>{assert.equal(input.requireUserVerification,true);if(options.authGate)await options.authGate;return {verified:true,authenticationInfo:{newCounter:input.credential.counter+1}};},
    generateRegistrationOptions:async()=>({challenge:'enroll'}),
    verifyRegistrationResponse:async()=>({verified:true,registrationInfo:{credential:{id:'second',publicKey:Uint8Array.of(1),counter:0}}}),
  };
  const exports = {};
  new Function('require','exports',compiled)(name=>({'node:crypto':crypto,'node:fs/promises':fs,'node:path':path,'@simplewebauthn/server':webauthn}[name]),exports);
  return exports;
}
const request = new Request('http://localhost', {headers:{host:'localhost'}});
const hash = data=>crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
async function approve(api,digest,id='owner') {
  const {challengeId} = await api.authenticationOptions(request,digest);
  return api.verifyAuthentication(request,challengeId,{id});
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

test('credential corruption and unreadable storage fail closed rather than allowing owner enrollment',async()=>{
  for(const api of [fixture(undefined,'{broken'),fixture(Object.assign(new Error('denied'),{code:'EACCES'})),fixture(undefined,'{}')]) {
    await assert.rejects(api.passkeyStatus(),/Cannot read passkey/);
    await assert.rejects(api.registrationOptions(request));
  }
  const empty=fixture(Object.assign(new Error('missing'),{code:'ENOENT'}));
  assert.equal((await empty.passkeyStatus()).registered,false);
});

test('removing old credentials requires exact approval, preserves a final credential, and invalidates outstanding authority',async()=>{
  const raw=JSON.stringify({credentials:[
    {id:'owner',publicKey:'AA==',counter:0,label:'Owner',createdAt:''},
    {id:'old',publicKey:'AA==',counter:0,label:'Old device',createdAt:''},
  ],revoked:false});
  const api=fixture(undefined,raw);
  const listing=await approve(api,hash({action:'list-passkeys'}));
  assert.equal((await api.listCredentials(listing.approvalId)).length,2);
  const pending=await approve(api,hash({action:'wallet-command',command:'balance'}));
  await assert.rejects(api.removeCredential('old',pending.approvalId));
  const removal=await approve(api,hash({action:'remove-passkey',id:'old'}));
  await api.removeCredential('old',removal.approvalId);
  await assert.rejects(api.consumeApproval(pending.approvalId,hash({action:'wallet-command',command:'balance'})));
  assert.equal((await api.passkeyStatus()).credentialCount,1);
  const last=await approve(api,hash({action:'remove-passkey',id:'owner'}));
  await assert.rejects(api.removeCredential('owner',last.approvalId),/last one/);
});
test('local recovery is single use, invalidates approvals, locks access, and binds replacement enrollment to its recovery tab',async()=>{
  const code='a'.repeat(64),api=fixture(undefined,undefined,{recoveryCode:code});
  const pending=await approve(api,hash({action:'wallet-command',command:'balance'}));
  await assert.rejects(api.recoverCredentials('b'.repeat(64)));
  const token=await api.recoverCredentials(code);
  assert.deepEqual(await api.passkeyStatus(),{registered:false,credentialCount:0,revoked:true,recoveryPending:true});
  await assert.rejects(api.consumeApproval(pending.approvalId,hash({action:'wallet-command',command:'balance'})));
  await assert.rejects(api.recoverCredentials(code));
  await assert.rejects(api.registrationOptions(request),/recovery tab/);
  await assert.rejects(api.registrationOptions(request,undefined,'b'.repeat(64)));
  const {challengeId}=await api.registrationOptions(request,undefined,token);
  await api.verifyRegistration(request,challengeId,{response:{transports:[]}});
  assert.deepEqual(await api.passkeyStatus(),{registered:true,credentialCount:1,revoked:true,recoveryPending:false});
  const unlockHash=hash({action:'restore-ai-access',network:'testnet',reason:'Owner unlock'});
  const unlock=await approve(api,unlockHash,'second');
  await api.consumeApproval(unlock.approvalId,unlockHash);
  await api.setRevoked(false);
  assert.equal((await api.passkeyStatus()).revoked,false);
});
test('expired recovery fails closed and an authentication in flight cannot resurrect removed credentials',async()=>{
  const code='a'.repeat(64),expired=fixture(undefined,undefined,{recoveryCode:code,expiresAt:Date.now()-1});
  await assert.rejects(expired.recoverCredentials(code));
  assert.equal((await expired.passkeyStatus()).registered,true);
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const api=fixture(undefined,undefined,{recoveryCode:code,authGate:gate});
  const {challengeId}=await api.authenticationOptions(request,hash({action:'wallet-command',command:'balance'}));
  const authentication=api.verifyAuthentication(request,challengeId,{id:'owner'});
  await api.recoverCredentials(code);
  release();
  await assert.rejects(authentication,/Credentials changed/);
  assert.equal((await api.passkeyStatus()).registered,false);
});
