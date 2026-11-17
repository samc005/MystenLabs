// Local operator action only. Never expose this script as an agent tool.
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
const directory = path.join(process.cwd(), '.passkey');
await mkdir(directory, { recursive: true, mode: 0o700 });
const code = randomBytes(32).toString('hex');
const temporary = path.join(directory, 'recovery-' + randomUUID() + '.tmp');
await writeFile(temporary, JSON.stringify({
  hash: createHash('sha256').update(code).digest('hex'),
  expiresAt: Date.now() + 10 * 60_000,
}), { mode: 0o600, flag: 'wx' });
await rename(temporary, path.join(directory, 'recovery.json'));
console.log('Open http://localhost:3000/passkeys and enter this one-use recovery code within 10 minutes:');
console.log(code);
console.log('Keep this code private. Recovery backs up old registrations and locks wallet actions until you register a new passkey and unlock.');
console.log('It does not delete keys from your password manager or move on-chain funds. A newly generated code invalidates the previous code.');
