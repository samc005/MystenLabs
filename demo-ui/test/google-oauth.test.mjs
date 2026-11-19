import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signData } from 'node:crypto';
import { loadTs } from './load-ts.mjs';

const oauth = loadTs('lib/server/google-oauth.ts');
const clientId = 'client-123.apps.googleusercontent.com';
const nonce = 'nonce-abc';
const now = 1_800_000_000_000;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'test-key';
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] };

function token({ header = {}, claims = {}, key = privateKey } = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = encode({ alg: 'RS256', kid, typ: 'JWT', ...header });
  const body = encode({
    iss: 'https://accounts.google.com',
    aud: clientId,
    sub: 'google-sub-42',
    email: 'friend@example.com',
    email_verified: true,
    name: 'Friend',
    nonce,
    iat: now / 1000,
    exp: now / 1000 + 3600,
    ...claims,
  });
  const signature = signData('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${signature}`;
}

const verify = (value, extra = {}) => oauth.verifyIdToken(value, { clientId, nonce, jwks, now, ...extra });

test('accepts a token Google signed for this app and nonce', async () => {
  const claims = await verify(token());
  assert.equal(claims.sub, 'google-sub-42');
  assert.equal(claims.email, 'friend@example.com');
  assert.equal(claims.email_verified, true);
});

test('rejects tokens with a bad signature, unknown key, or a changed payload', async () => {
  const good = token();
  const [head, , sig] = good.split('.');
  const tampered = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: clientId, sub: 'admin', nonce, exp: now / 1000 + 3600 })).toString('base64url');
  await assert.rejects(verify(`${head}.${tampered}.${sig}`), /signature is invalid/);
  await assert.rejects(verify(token({ header: { kid: 'other' } })), /unknown key/);
  const { privateKey: attacker } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(verify(token({ key: attacker })), /signature is invalid/);
});

test('rejects the wrong issuer, audience, nonce, expiry, or algorithm', async () => {
  await assert.rejects(verify(token({ claims: { iss: 'https://evil.example' } })), /issuer/);
  await assert.rejects(verify(token({ claims: { aud: 'someone-else' } })), /different app/);
  await assert.rejects(verify(token({ claims: { nonce: 'replayed' } })), /does not match/);
  await assert.rejects(verify(token({ claims: { exp: now / 1000 - 1 } })), /expired/);
  await assert.rejects(verify(token({ header: { alg: 'HS256' } })), /Unsupported/);
  await assert.rejects(verify('not-a-jwt'), /Malformed/);
});

test('an unverified email is returned as such, for the callback to refuse', async () => {
  const claims = await verify(token({ claims: { email_verified: false } }));
  assert.equal(claims.email_verified, false);
});

test('the authorization URL carries state, nonce, PKCE and the openid scope', () => {
  const url = new URL(oauth.authorizationUrl(
    { clientId, clientSecret: 's', redirectUri: 'http://localhost:3000/api/auth/google/callback' },
    { state: 'st', nonce: 'no', codeChallenge: 'ch' },
  ));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('nonce'), 'no');
  assert.equal(url.searchParams.get('code_challenge'), 'ch');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
});

test('PKCE challenge matches the RFC 7636 example', () => {
  assert.equal(
    oauth.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('sign-in refuses to start without client credentials', () => {
  assert.throws(() => oauth.googleConfig({}), /GOOGLE_CLIENT_ID/);
  assert.equal(
    oauth.googleConfig({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' }).redirectUri,
    'http://localhost:3000/api/auth/google/callback',
  );
});
