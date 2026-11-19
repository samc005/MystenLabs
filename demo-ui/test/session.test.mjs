import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

const secret = 'x'.repeat(40);
process.env.SESSION_SECRET = secret;
const session = loadTs('lib/server/session.ts');

test('a sealed value round-trips until it expires', () => {
  const token = session.seal({ sub: 'sub-1', email: 'a@example.com' }, 60_000, 1_000);
  assert.equal(session.unseal(token, 1_000 + 59_000).sub, 'sub-1');
  assert.equal(session.unseal(token, 1_000 + 61_000), null);
});

test('any change to a sealed value is rejected', () => {
  const [body, mac] = session.seal({ sub: 'sub-1' }, 60_000).split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'someone-else', exp: Date.now() + 60_000 })).toString('base64url');
  assert.equal(session.unseal(`${forged}.${mac}`), null);
  assert.equal(session.unseal(`${body}.${mac.slice(0, -2)}AA`), null);
  assert.equal(session.unseal(`${body}.${mac}.extra`), null);
  assert.equal(session.unseal(undefined), null);
});

test('a value sealed under a different secret is rejected', () => {
  const token = session.seal({ sub: 'sub-1' }, 60_000);
  process.env.SESSION_SECRET = 'y'.repeat(40);
  try {
    assert.equal(session.unseal(token), null);
  } finally {
    process.env.SESSION_SECRET = secret;
  }
});

test('a short or missing secret refuses to sign anything', () => {
  const previous = process.env.SESSION_SECRET;
  try {
    process.env.SESSION_SECRET = 'too-short';
    assert.throws(() => session.seal({ sub: 'sub-1' }, 60_000), /SESSION_SECRET/);
    delete process.env.SESSION_SECRET;
    assert.throws(() => session.seal({ sub: 'sub-1' }, 60_000), /SESSION_SECRET/);
  } finally {
    process.env.SESSION_SECRET = previous;
  }
});

test('userFromRequest reads only the session cookie, among others', () => {
  const token = session.seal({ sub: 'sub-1', email: 'a@example.com' }, 60_000);
  const request = new Request('http://localhost:3000/', {
    headers: { cookie: `theme=dark; ${session.SESSION_COOKIE}=${token}; other=1` },
  });
  assert.deepEqual(session.userFromRequest(request), { sub: 'sub-1', email: 'a@example.com', name: undefined });
  assert.equal(session.userFromRequest(new Request('http://localhost:3000/')), null);
  const wrongName = new Request('http://localhost:3000/', { headers: { cookie: `not_session=${token}` } });
  assert.equal(session.userFromRequest(wrongName), null);
});
