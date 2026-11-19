import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { toBase58 } from "@mysten/sui/utils";
import { openKeyring } from "../src/signer/keyring.js";
import { signerHost } from "../src/signer/protocol.js";
import { createSignerServer } from "../src/signer/server.js";

test("keyring mints private per-account keys that survive a restart and respect the cap", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wallet-keyring-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "keys");

  const keyring = await openKeyring(dir, { max: 2 });
  const [first, second] = await Promise.all([keyring.create(), keyring.create()]);
  assert.notEqual(first, second);
  assert.match(first, /^0x[0-9a-f]{64}$/);
  await assert.rejects(keyring.create(), /keyring_full/);
  assert.equal(keyring.size(), 2);

  for (const name of await readdir(dir)) assert.equal((await stat(join(dir, name))).mode & 0o077, 0);

  const reopened = await openKeyring(dir, { max: 2 });
  assert.equal(reopened.size(), 2);
  assert.equal(reopened.get(first)?.toSuiAddress(), first);
  assert.equal(reopened.get(`0x${"0".repeat(64)}`), undefined);
});

test("signer provisions agent keys and signs only for the sender that owns the key", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "wallet-signer-keyring-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(join(stateDir, "approvals"));
  await mkdir(join(stateDir, "consumed"));
  const keyring = await openKeyring(join(stateDir, "keys"));
  const token = randomBytes(32).toString("hex");
  const chainIdentifier = toBase58(new Uint8Array(32).fill(1));
  const server = createSignerServer({ token, stateDir, chainIdentifier, keyring, getCurrentEpoch: async () => 7n });
  server.listen(0, signerHost);
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://${signerHost}:${address.port}`;

  async function post(path: string, body: unknown, bearer = token) {
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  assert.equal((await post("/provision", {}, "bad-token")).status, 401);
  assert.equal((await post("/provision", { extra: true })).status, 400);
  const response = await post("/provision", {});
  assert.equal(response.status, 200);
  const { address: agent } = (await response.json()) as { address: string };
  const agentKey = keyring.get(agent);
  assert(agentKey);

  async function sign(sender: string, proposalId: string) {
    const tx = new Transaction();
    tx.setSender(sender);
    tx.setGasOwner(sender);
    tx.setGasBudget(5_000_000);
    tx.setGasPrice(1000);
    tx.setGasPayment([]);
    tx.setExpiration({
      ValidDuring: { chain: chainIdentifier, minEpoch: "7", maxEpoch: "8", minTimestamp: null, maxTimestamp: null, nonce: 1 },
    });
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(1)]);
    tx.transferObjects([coin], sender);
    const transactionBytes = Buffer.from(await tx.build()).toString("base64");
    const input = {
      network: "testnet",
      proposalId,
      transactionBytes,
      policyDecision: { id: `decision-${proposalId}`, allowed: true },
    };
    await writeFile(
      join(stateDir, "approvals", `${proposalId}.json`),
      JSON.stringify({ ...input, expiresAtMs: Date.now() + 60_000 }),
    );
    return { response: await post("/sign", input), transactionBytes };
  }

  const ok = await sign(agent, "agent-payment-1");
  assert.equal(ok.response.status, 200);
  const { signature } = (await ok.response.json()) as { signature: string };
  assert(await agentKey.getPublicKey().verifyTransaction(Buffer.from(ok.transactionBytes, "base64"), signature));

  // A different account's address, or any address the signer never minted, is refused even if approved.
  const stranger = new Ed25519Keypair().toSuiAddress();
  const refused = await sign(stranger, "stranger-payment-1");
  assert.equal(refused.response.status, 403);
  assert.deepEqual(await refused.response.json(), { error: "transaction_outside_signer_scope" });
});
