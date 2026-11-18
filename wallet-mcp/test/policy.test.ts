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
import { evaluateTransaction, type PolicyConfig } from "../src/policy/evaluate.js";
import { signerHost } from "../src/signer/protocol.js";
import { createSignerServer } from "../src/signer/server.js";

const agent = new Ed25519Keypair();
const other = new Ed25519Keypair();
const id = (n: number) => normalizeSuiAddress(`0x${n.toString(16)}`);
const PKG = id(0xa1);
const OLD_PKG = id(0xa0);
const VAULT = id(0xb1);
const CAP = id(0xc1);
const POOL_PKG = id(0xd1);
const POOL = id(0xd2);
const FOREIGN = id(0xee);

const config: PolicyConfig = {
  agentAddress: agent.toSuiAddress(),
  vaultPackageId: PKG,
  vaultId: VAULT,
  agentCapId: CAP,
  pool: { packageId: POOL_PKG, poolId: POOL },
};

const digest = toBase58(new Uint8Array(32).fill(7));
const owned = (objectId: string) => ({ objectId, version: "1", digest });
const shared = (objectId: string) => ({ objectId, initialSharedVersion: "1", mutable: true });

async function build(
  fill: (tx: Transaction) => void,
  { sender = agent.toSuiAddress(), gasOwner = sender, budget = 5_000_000 } = {},
) {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasOwner(gasOwner);
  tx.setGasBudget(budget);
  tx.setGasPrice(1000);
  tx.setGasPayment([]);
  tx.setExpiration({
    ValidDuring: { chain: digest, minEpoch: "7", maxEpoch: "8", minTimestamp: null, maxTimestamp: null, nonce: 1 },
  });
  fill(tx);
  return tx.build();
}

const spend = (tx: Transaction, pkg = PKG, fn = "spend", cap = CAP, vault = VAULT) =>
  tx.moveCall({
    target: `${pkg}::spending_vault::${fn}`,
    arguments: [
      tx.objectRef(owned(cap)),
      tx.sharedObjectRef(shared(vault)),
      tx.pure.address(other.toSuiAddress()),
      tx.pure.u64(1),
    ],
  });

async function decide(fill: (tx: Transaction) => void, opts?: Parameters<typeof build>[1], cfg = config) {
  return evaluateTransaction(await build(fill, opts), cfg);
}

test("allows the vault calls the agent is meant to make", async () => {
  const direct = await decide((tx) => spend(tx));
  assert.deepEqual(direct, { allowed: true, reasons: [], calls: [`${PKG}::spending_vault::spend`] });

  const swap = await decide((tx) => {
    const [coinIn, ticket] = tx.moveCall({
      target: `${PKG}::spending_vault::begin_swap_auto`,
      typeArguments: ["0x2::sui::SUI", `${POOL_PKG}::test_usdc::TEST_USDC`],
      arguments: [tx.objectRef(owned(CAP)), tx.sharedObjectRef(shared(VAULT)), tx.pure.u64(1), tx.pure.u64(1)],
    });
    const [coinOut] = tx.moveCall({
      target: `${POOL_PKG}::test_usdc::swap_sui_for_usdc`,
      arguments: [tx.sharedObjectRef(shared(POOL)), coinIn!],
    });
    tx.moveCall({
      target: `${PKG}::spending_vault::finish_swap`,
      typeArguments: ["0x2::sui::SUI", `${POOL_PKG}::test_usdc::TEST_USDC`],
      arguments: [ticket!, tx.sharedObjectRef(shared(VAULT)), coinOut!],
    });
  });
  assert.equal(swap.allowed, true, swap.reasons.join());

  const stake = await decide((tx) =>
    tx.moveCall({
      target: `${PKG}::spending_vault::stake`,
      arguments: [
        tx.objectRef(owned(CAP)),
        tx.sharedObjectRef(shared(VAULT)),
        tx.sharedObjectRef(shared("0x5")),
        tx.pure.address(other.toSuiAddress()),
        tx.pure.u64(1_000_000_000),
      ],
    }),
  );
  assert.equal(stake.allowed, true, stake.reasons.join());
});

test("denies a transfer of the AgentCap or any object", async () => {
  const d = await decide((tx) => tx.transferObjects([tx.objectRef(owned(CAP))], other.toSuiAddress()));
  assert.equal(d.allowed, false);
  assert(d.reasons.includes("command_not_allowed:TransferObjects"));
});

test("denies draining the agent gas coin", async () => {
  const d = await decide((tx) => {
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(1)]);
    tx.transferObjects([coin!], other.toSuiAddress());
  });
  assert.equal(d.allowed, false);
  assert(d.reasons.includes("command_not_allowed:SplitCoins"));
  assert(d.reasons.includes("command_not_allowed:TransferObjects"));
});

test("denies owner-only vault functions", async () => {
  for (const fn of ["withdraw", "set_paused", "issue_agent_cap", "set_per_tx_limit", "unstake", "set_trade_rule"]) {
    const d = await decide((tx) => spend(tx, PKG, fn));
    assert.deepEqual(d.reasons, [`vault_function_not_allowed:${fn}`], fn);
  }
});

test("denies old package versions and unknown packages", async () => {
  const old = await decide((tx) => spend(tx, OLD_PKG));
  assert.equal(old.allowed, false);
  assert(old.reasons.some((r) => r.startsWith("call_target_not_allowed:")));

  const unknown = await decide((tx) =>
    tx.moveCall({ target: `${FOREIGN}::evil::drain`, arguments: [tx.sharedObjectRef(shared(VAULT))] }),
  );
  assert(unknown.reasons.some((r) => r.startsWith("call_target_not_allowed:")));
});

test("denies unexpected pool functions and any pool call when no pool is configured", async () => {
  const fill = (tx: Transaction) =>
    tx.moveCall({
      target: `${POOL_PKG}::test_usdc::set_price`,
      arguments: [tx.sharedObjectRef(shared(POOL)), tx.pure.u64(1)],
    });
  assert.deepEqual((await decide(fill)).reasons, ["pool_function_not_allowed:set_price"]);

  const swap = (tx: Transaction) =>
    tx.moveCall({
      target: `${POOL_PKG}::test_usdc::swap_sui_for_usdc`,
      arguments: [tx.sharedObjectRef(shared(POOL)), tx.pure.u64(1)],
    });
  const { pool: _pool, ...noPool } = config;
  const d = await decide(swap, undefined, noPool);
  assert(d.reasons.some((r) => r.startsWith("call_target_not_allowed:")));
  assert(d.reasons.includes("foreign_object_input"));
});

test("denies objects the agent flows never use", async () => {
  const d = await decide((tx) =>
    tx.moveCall({
      target: `${PKG}::spending_vault::spend`,
      arguments: [
        tx.objectRef(owned(FOREIGN)),
        tx.sharedObjectRef(shared(VAULT)),
        tx.pure.address(other.toSuiAddress()),
        tx.pure.u64(1),
      ],
    }),
  );
  assert.deepEqual(d.reasons, ["foreign_object_input"]);
});

test("denies the wrong sender, wrong gas owner and a large gas budget", async () => {
  const wrongSender = await decide((tx) => spend(tx), {
    sender: other.toSuiAddress(),
    gasOwner: agent.toSuiAddress(),
  });
  assert.deepEqual(wrongSender.reasons, ["sender_not_agent"]);

  const sponsored = await decide((tx) => spend(tx), { gasOwner: other.toSuiAddress() });
  assert.deepEqual(sponsored.reasons, ["gas_owner_not_agent"]);

  const heavy = await decide((tx) => spend(tx), { budget: 100_000_001 });
  assert.deepEqual(heavy.reasons, ["gas_budget_too_high"]);
  const atLimit = await decide((tx) => spend(tx), { budget: 100_000_000 });
  assert.equal(atLimit.allowed, true);
});

test("denies publishes and upgrades-shaped extra commands appended to a valid call", async () => {
  const d = await decide((tx) => {
    spend(tx);
    tx.makeMoveVec({ elements: [tx.pure.u64(1)], type: "u64" });
  });
  assert(d.reasons.includes("command_not_allowed:MakeMoveVec"));
});

test("denies empty and unparseable transactions", async () => {
  assert.deepEqual(evaluateTransaction(new Uint8Array([1, 2, 3]), config).reasons, ["unparseable_transaction"]);
  assert(
    (await decide(() => {})).reasons.includes("no_commands"),
  );
});

test("is deterministic", async () => {
  const bytes = await build((tx) => spend(tx));
  assert.deepEqual(evaluateTransaction(bytes, config), evaluateTransaction(bytes, config));
});

test("signer refuses a policy-violating transaction without consuming the approval", async (t) => {
  const token = randomBytes(32).toString("hex");
  const stateDir = await mkdtemp(join(tmpdir(), "wallet-policy-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(join(stateDir, "approvals"));
  await mkdir(join(stateDir, "consumed"));

  const server = createSignerServer({
    token,
    stateDir,
    chainIdentifier: digest,
    keypair: agent,
    getCurrentEpoch: async () => 7n,
    policy: config,
  });
  server.listen(0, signerHost);
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== "string");

  async function submit(proposalId: string, bytes: Uint8Array) {
    const transactionBytes = Buffer.from(bytes).toString("base64");
    const input = {
      network: "testnet",
      proposalId,
      transactionBytes,
      policyDecision: { id: "decision-1", allowed: true },
    };
    await writeFile(
      join(stateDir, "approvals", `${proposalId}.json`),
      JSON.stringify({ ...input, expiresAtMs: Date.now() + 60_000 }),
    );
    const response = await fetch(`http://${signerHost}:${address.port}/sign`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const bad = await build((tx) => tx.transferObjects([tx.objectRef(owned(CAP))], other.toSuiAddress()));
  const denied = await submit("transfer-cap", bad);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, "policy_denied");
  assert.deepEqual(denied.body.reasons, ["command_not_allowed:TransferObjects"]);

  // The refusal happened before the claim, so a corrected request is not "already consumed".
  const retry = await submit("transfer-cap", bad);
  assert.equal(retry.body.error, "policy_denied");

  const good = await submit("pay-1", await build((tx) => spend(tx)));
  assert.equal(good.status, 200);
  assert.equal(typeof good.body.signature, "string");
});
