import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase58 } from "@mysten/sui/utils";
import { evaluateEffects, type EffectsConfig, type SimulatedEffects } from "../src/policy/effects.js";
import type { PolicyConfig } from "../src/policy/evaluate.js";
import { signerHost } from "../src/signer/protocol.js";
import { createSignerServer } from "../src/signer/server.js";

const agent = new Ed25519Keypair();
const alice = new Ed25519Keypair().toSuiAddress();
const mallory = new Ed25519Keypair().toSuiAddress();
const id = (n: number) => normalizeSuiAddress(`0x${n.toString(16)}`);
const PKG = id(0xa1);
const VAULT = id(0xb1);
const CAP = id(0xc1);
const SUI = "0x2::sui::SUI";
const OTHER_COIN = `${id(0xf1)}::x::X`;
const digest = toBase58(new Uint8Array(32).fill(7));

const cfg: EffectsConfig = { agentAddress: agent.toSuiAddress(), agentCapId: CAP };

function effects(overrides: Partial<SimulatedEffects> = {}): SimulatedEffects {
  return {
    success: true,
    error: null,
    balanceChanges: [{ address: agent.toSuiAddress(), coinType: SUI, amount: "-2000000" }],
    changedObjects: [],
    ...overrides,
  };
}
const credit = (address: string, amount: string, coinType = SUI) => ({ address, coinType, amount });

test("allows a payment that credits only the approved recipient within the approved amount", () => {
  const sim = effects({ balanceChanges: [...effects().balanceChanges, credit(alice, "1000000000")] });
  assert.deepEqual(evaluateEffects(sim, cfg, { credits: { [alice]: 1_000_000_000n } }), { allowed: true, reasons: [] });
  // Exact-address matching is normalization-insensitive.
  assert.equal(evaluateEffects(sim, cfg, { credits: { [alice.toUpperCase().replace("0X", "0x")]: 1_000_000_000n } }).allowed, true);
});

test("denies a credit to anyone when nothing was approved", () => {
  const sim = effects({ balanceChanges: [...effects().balanceChanges, credit(mallory, "1")] });
  assert.deepEqual(evaluateEffects(sim, cfg).reasons, ["unexpected_credit"]);
});

test("denies a credit to someone other than the approved recipient", () => {
  const sim = effects({ balanceChanges: [...effects().balanceChanges, credit(mallory, "1000")] });
  assert.deepEqual(evaluateEffects(sim, cfg, { credits: { [alice]: 1_000n } }).reasons, ["unexpected_credit"]);
});

test("denies paying the approved recipient more than approved, or in another coin", () => {
  const more = effects({ balanceChanges: [credit(alice, "1001")] });
  assert.deepEqual(evaluateEffects(more, cfg, { credits: { [alice]: 1_000n } }).reasons, ["credit_exceeds_approval"]);
  const coin = effects({ balanceChanges: [credit(alice, "5", OTHER_COIN)] });
  assert.deepEqual(evaluateEffects(coin, cfg, { credits: { [alice]: 1_000n } }).reasons, ["unexpected_credit"]);
});

test("denies the agent wallet losing more than the gas budget, or losing other coins", () => {
  const drain = effects({ balanceChanges: [{ address: agent.toSuiAddress(), coinType: SUI, amount: "-100000001" }] });
  assert.deepEqual(evaluateEffects(drain, cfg).reasons, ["agent_balance_drain"]);
  const atLimit = effects({ balanceChanges: [{ address: agent.toSuiAddress(), coinType: SUI, amount: "-100000000" }] });
  assert.equal(evaluateEffects(atLimit, cfg).allowed, true);
  const other = effects({ balanceChanges: [{ address: agent.toSuiAddress(), coinType: OTHER_COIN, amount: "-1" }] });
  assert.deepEqual(evaluateEffects(other, cfg).reasons, ["agent_balance_drain"]);
});

test("a swap or stake that credits nobody and costs only gas is allowed", () => {
  assert.equal(evaluateEffects(effects(), cfg).allowed, true);
});

test("denies a failed simulation", () => {
  assert.deepEqual(evaluateEffects(effects({ success: false, error: "abort" }), cfg).reasons, ["simulation_failed"]);
});

test("denies the AgentCap changing owner or disappearing, allows it staying put", () => {
  const stays = effects({
    changedObjects: [{ objectId: CAP, idOperation: "None", outputState: "ObjectWrite", outputOwnerAddress: agent.toSuiAddress() }],
  });
  assert.equal(evaluateEffects(stays, cfg).allowed, true);
  const moved = effects({
    changedObjects: [{ objectId: CAP, idOperation: "None", outputState: "ObjectWrite", outputOwnerAddress: mallory }],
  });
  assert.deepEqual(evaluateEffects(moved, cfg).reasons, ["agent_cap_moved"]);
  const shared = effects({
    changedObjects: [{ objectId: CAP, idOperation: "None", outputState: "ObjectWrite", outputOwnerAddress: null }],
  });
  assert.deepEqual(evaluateEffects(shared, cfg).reasons, ["agent_cap_moved"]);
  const deleted = effects({
    changedObjects: [{ objectId: CAP, idOperation: "Deleted", outputState: "DoesNotExist", outputOwnerAddress: null }],
  });
  assert.deepEqual(evaluateEffects(deleted, cfg).reasons, ["agent_cap_moved"]);
});

test("signer runs its own dry run and enforces the approved expectation", async (t) => {
  const token = randomBytes(32).toString("hex");
  const stateDir = await mkdtemp(join(tmpdir(), "wallet-effects-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(join(stateDir, "approvals"));
  await mkdir(join(stateDir, "consumed"));

  const policy: PolicyConfig = {
    agentAddress: agent.toSuiAddress(),
    vaultPackageId: PKG,
    vaultId: VAULT,
    agentCapId: CAP,
  };
  let simulated: SimulatedEffects | "unavailable" = effects();
  let simulations = 0;
  const server = createSignerServer({
    token,
    stateDir,
    chainIdentifier: digest,
    keypair: agent,
    getCurrentEpoch: async () => 7n,
    policy,
    simulate: async () => {
      simulations++;
      if (simulated === "unavailable") throw new Error("node down");
      return simulated;
    },
  });
  server.listen(0, signerHost);
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== "string");

  const owned = { objectId: CAP, version: "1", digest };
  const bytes = await (async () => {
    const tx = new Transaction();
    tx.setSender(agent.toSuiAddress());
    tx.setGasOwner(agent.toSuiAddress());
    tx.setGasBudget(5_000_000);
    tx.setGasPrice(1000);
    tx.setGasPayment([]);
    tx.setExpiration({ ValidDuring: { chain: digest, minEpoch: "7", maxEpoch: "8", minTimestamp: null, maxTimestamp: null, nonce: 1 } });
    tx.moveCall({
      target: `${PKG}::spending_vault::spend`,
      arguments: [
        tx.objectRef(owned),
        tx.sharedObjectRef({ objectId: VAULT, initialSharedVersion: "1", mutable: true }),
        tx.pure.address(alice),
        tx.pure.u64(1000),
      ],
    });
    return Buffer.from(await tx.build()).toString("base64");
  })();

  async function submit(proposalId: string, expectation?: { credits: Record<string, string> }) {
    const input = {
      network: "testnet",
      proposalId,
      transactionBytes: bytes,
      policyDecision: { id: "decision-1", allowed: true },
    };
    await writeFile(
      join(stateDir, "approvals", `${proposalId}.json`),
      JSON.stringify({ ...input, ...(expectation ? { expectation } : {}), expiresAtMs: Date.now() + 60_000 }),
    );
    const response = await fetch(`http://${signerHost}:${address.port}/sign`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  // The UI-approved recipient is Alice, but the dry run says Mallory gets paid.
  simulated = effects({ balanceChanges: [...effects().balanceChanges, credit(mallory, "1000")] });
  const redirected = await submit("pay-1", { credits: { [alice]: "1000" } });
  assert.equal(redirected.status, 403);
  assert.equal(redirected.body.error, "effects_denied");
  assert.deepEqual(redirected.body.reasons, ["unexpected_credit"]);

  // No expectation written: any credit is unexpected.
  simulated = effects({ balanceChanges: [...effects().balanceChanges, credit(alice, "1000")] });
  const bare = await submit("pay-2");
  assert.equal(bare.body.error, "effects_denied");

  // A node outage fails closed and does not burn the approval.
  simulated = "unavailable";
  const down = await submit("pay-3", { credits: { [alice]: "1000" } });
  assert.equal(down.status, 502);
  assert.equal(down.body.error, "simulation_unavailable");

  // Correct effects: signed. The same proposal ID that was refused earlier is still usable.
  simulated = effects({ balanceChanges: [...effects().balanceChanges, credit(alice, "1000")] });
  const ok = await submit("pay-3", { credits: { [alice]: "1000" } });
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.body.signature, "string");
  assert(simulations >= 4);

  // Consumed now.
  const again = await submit("pay-3", { credits: { [alice]: "1000" } });
  assert.equal(again.status, 409);
});
