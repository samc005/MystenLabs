import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
test('local CLI issues an expiring code, stores only its hash privately, and supersedes old codes',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'passkey-recovery-test-'));
  const script=fileURLToPath(new URL('../scripts/recover-passkeys.mjs',import.meta.url));
  try {
    const generate=()=>{
      const result=spawnSync(process.execPath,[script],{cwd:directory,encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
      const code=result.stdout.split('\n').find(line=>/^[a-f0-9]{64}$/.test(line));
      assert.ok(code);return code;
    };
    const first=generate();
    const file=path.join(directory,'.passkey','recovery.json');
    const record=JSON.parse(await readFile(file,'utf8'));
    assert.equal(record.hash,createHash('sha256').update(first).digest('hex'));
    assert.ok(record.expiresAt>Date.now()&&record.expiresAt<=Date.now()+600_000);
    assert.equal((await stat(file)).mode&0o777,0o600);
    assert.equal((await stat(path.dirname(file))).mode&0o777,0o700);
    assert.equal(JSON.stringify(record).includes(first),false);
    const second=generate();
    const replacement=JSON.parse(await readFile(file,'utf8'));
    assert.equal(replacement.hash,createHash('sha256').update(second).digest('hex'));
    assert.notEqual(replacement.hash,record.hash);
  } finally {await rm(directory,{recursive:true,force:true});}
});
