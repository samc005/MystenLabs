import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { loadTs } from './load-ts.mjs';

process.env.SESSION_SECRET = 'x'.repeat(40);
const proof = loadTs('lib/server/owner-proof.ts', { '@/lib/sui': { createSuiClient: () => ({}) } });
const user = (sub, extra = {}) => ({ sub, email: `${sub}@example.com`, ...extra });

async function signed(keypair, forUser, address = keypair.toSuiAddress()) {
  const { message, token } = proof.issueLinkChallenge(forUser, address);
  const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(message));
  return { token, signature };
}

test('a zkLogin owner must be the address derived for this sign-in', async () => {
  const zk = `0x${'a'.repeat(64)}`;
  await proof.assertOwnerControl(user('s1', { zkAddress: zk }), { ownerAddress: zk, ownerKind: 'zklogin' });
  await assert.rejects(
    proof.assertOwnerControl(user('s1', { zkAddress: zk }), { ownerAddress: `0x${'b'.repeat(64)}`, ownerKind: 'zklogin' }),
    /not your sign-in wallet/,
  );
  await assert.rejects(proof.assertOwnerControl(user('s1'), { ownerAddress: zk, ownerKind: 'zklogin' }), /expired/);
});

test('a connected wallet proves control by signing the link message', async () => {
  const keypair = new Ed25519Keypair();
  const owner = keypair.toSuiAddress();
  await proof.assertOwnerControl(user('s1'), { ownerAddress: owner, ownerKind: 'wallet', proof: await signed(keypair, user('s1')) });
});

test('link proofs cannot be reused by another user, for another address, or by another key', async () => {
  const keypair = new Ed25519Keypair();
  const owner = keypair.toSuiAddress();
  const forOtherUser = await signed(keypair, user('s2'));
  await assert.rejects(proof.assertOwnerControl(user('s1'), { ownerAddress: owner, ownerKind: 'wallet', proof: forOtherUser }), /Sign the link message/);

  const victim = new Ed25519Keypair().toSuiAddress();
  const attacker = new Ed25519Keypair();
  const squat = await signed(attacker, user('s1'), victim);
  await assert.rejects(proof.assertOwnerControl(user('s1'), { ownerAddress: victim, ownerKind: 'wallet', proof: squat }), /did not match/);

  const valid = await signed(keypair, user('s1'));
  await assert.rejects(
    proof.assertOwnerControl(user('s1'), { ownerAddress: owner, ownerKind: 'wallet', proof: { ...valid, token: valid.token.replace(/.$/, 'A') } }),
    /Sign the link message/,
  );
  await assert.rejects(proof.assertOwnerControl(user('s1'), { ownerAddress: owner, ownerKind: 'browser' }), /Sign the link message/);
});
