import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { toBase58 } from "@mysten/sui/utils";
import { requestSignature } from "../src/signer/client.js";
import { signerHost, type approvalRecord, type signRequest } from "../src/signer/protocol.js";
import { createSignerServer } from "../src/signer/server.js";
import type { z } from "zod";

test("signer authenticates and signs only fresh, matching testnet approvals once", async (t) => {
  const keypair = new Ed25519Keypair();
  const otherKey = new Ed25519Keypair();
  const token = randomBytes(32).toString("hex");
  const chainIdentifier = toBase58(new Uint8Array(32).fill(1));
  const stateDir = await mkdtemp(join(tmpdir(), "wallet-signer-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(join(stateDir, "approvals"));
  await mkdir(join(stateDir, "consumed"));

  async function start() {
    const server = createSignerServer({
      token,
      chainIdentifier,
      stateDir,
      keypair,
      getCurrentEpoch: async () => 7n,
    });
    server.listen(0, signerHost);
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    return { server, port: address.port };
  }

  let { server, port } = await start();
  t.after(() => server.close());
  const previousToken = process.env.SUI_SIGNER_TOKEN;
  const previousPort = process.env.SUI_SIGNER_PORT;
  process.env.SUI_SIGNER_TOKEN = token;
  process.env.SUI_SIGNER_PORT = String(port);
  t.after(() => {
    if (previousToken === undefined) delete process.env.SUI_SIGNER_TOKEN;
    else process.env.SUI_SIGNER_TOKEN = previousToken;
    if (previousPort === undefined) delete process.env.SUI_SIGNER_PORT;
    else process.env.SUI_SIGNER_PORT = previousPort;
  });

  async function build({
    chain = chainIdentifier,
    sender = keypair.toSuiAddress(),
    minEpoch = "7",
    maxEpoch = "8",
    amount = 1,
  } = {}) {
    const tx = new Transaction();
    tx.setSender(sender);
    tx.setGasOwner(sender);
    tx.setGasBudget(5_000_000);
    tx.setGasPrice(1000);
    tx.setGasPayment([]);
    tx.setExpiration({ ValidDuring: { chain, minEpoch, maxEpoch, minTimestamp: null, maxTimestamp: null, nonce: 1 } });
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
    tx.transferObjects([coin], otherKey.toSuiAddress());
    return Buffer.from(await tx.build()).toString("base64");
  }

  const input: z.infer<typeof signRequest> = {
    network: "testnet",
    proposalId: "payment-123",
    transactionBytes: await build(),
    policyDecision: { id: "decision-123", allowed: true },
  };
  async function approve(overrides: Partial<z.infer<typeof approvalRecord>> = {}) {
    await writeFile(join(stateDir, "approvals", `${input.proposalId}.json`), JSON.stringify({
      ...input,
      expiresAtMs: Date.now() + 60_000,
      ...overrides,
    }));
  }

  async function expectRefusal(body: unknown, status: number, code: string, bearer = token) {
    const response = await fetch(`http://${signerHost}:${port}/sign`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
  }

  await expectRefusal(input, 401, "unauthorized", "bad-token");
  await expectRefusal({ ...input, network: "mainnet" }, 403, "wrong_network");
  await expectRefusal({ ...input, policyDecision: { id: "decision-123", allowed: false } }, 400, "invalid_signing_request");
  await expectRefusal(input, 403, "approval_required");
  await approve({ expiresAtMs: Date.now() - 1 });
  await expectRefusal(input, 403, "approval_expired");
  await approve();
  await expectRefusal({ ...input, transactionBytes: await build({ amount: 2 }) }, 403, "approval_mismatch");
  await expectRefusal({ ...input, policyDecision: { id: "different", allowed: true } }, 403, "approval_mismatch");

  for (const [transactionBytes, status, code] of [
    ["abcd", 400, "invalid_transaction_bytes"],
    [await build({ chain: toBase58(new Uint8Array(32).fill(2)) }), 403, "transaction_outside_signer_scope"],
    [await build({ sender: otherKey.toSuiAddress() }), 403, "transaction_outside_signer_scope"],
    [await build({ minEpoch: "5", maxEpoch: "6" }), 403, "transaction_outside_epoch_window"],
  ] as const) {
    await approve({ transactionBytes });
    await expectRefusal({ ...input, transactionBytes }, status, code);
  }

  await approve();
  const results = await Promise.allSettled([requestSignature(input), requestSignature(input)]);
  const signed = results.filter((result) => result.status === "fulfilled");
  assert.equal(signed.length, 1);
  assert(await keypair.getPublicKey().verifyTransaction(
    Buffer.from(input.transactionBytes, "base64"),
    signed[0].value,
  ));
  const refusals = results.filter((result) => result.status === "rejected");
  assert.match(String(refusals[0].reason), /proposal_already_consumed/);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  ({ server, port } = await start());
  await expectRefusal(input, 409, "proposal_already_consumed");
});
