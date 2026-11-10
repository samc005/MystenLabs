/**
 * Security boundary checks. Plays the agent (and a thief) against the live testnet vault
 * and reports whether each attack is rejected, and by which layer.
 *
 * Every attempt is a SIMULATION: nothing is signed or submitted. The wallet-mcp
 * client-side checks are skipped on purpose so the attempts reach the contract.
 *
 *   npm run boundaries
 *   npm run boundaries -- --expect-paused   (run while the owner has paused the vault)
 */
import { Transaction } from "@mysten/sui/transactions";
import { parseToMist, SUI_SYSTEM_STATE_OBJECT_ID } from "@mysten/sui/utils";
import { createSuiClient } from "../blockchain/client.js";
import { getVaultStatus } from "../blockchain/vault.js";
import { requireWallet } from "../blockchain/wallet.js";
import { resolveNetwork, vaultConfig } from "../config.js";

const ABORT_NAMES: Record<string, string> = {
  "0": "EWrongVault",
  "1": "EPaused",
  "2": "EOverLimit",
  "3": "EInsufficientFunds",
  "4": "ERevoked",
  "5": "EValidatorNotAllowed",
  "6": "EStakeNotFound",
};

/** An address that is not on the allowlist (Mysten-4 on testnet; any non-allowed address works). */
const NON_ALLOWED_VALIDATOR = "0xa0f3df744df29b87aa98b6e252f3cc43398c034aad60152808e32a08d09d6ca5";
/** A funded address that does NOT own the AgentCap (the vault owner's CLI address). */
const NOT_THE_AGENT = "0x6cac43adf6f5c1188df9b2acc5cccb298d590141d1623f8612b925a8b8d4bd64";
const SOME_RECIPIENT = "0x0000000000000000000000000000000000000000000000000000000000000001";

type Outcome = { ok: true } | { ok: false; reason: string };

async function main() {
  const expectPaused = process.argv.includes("--expect-paused");
  const network = resolveNetwork();
  const client = createSuiClient(network);
  const config = vaultConfig();
  const agent = (await requireWallet(network)).keypair.toSuiAddress();
  const status = await getVaultStatus(client, config);
  const allowed = status.allowedValidators[0];
  const receipt = status.stakes[0]?.stakedSuiId;
  const target = (fn: string) => `${config.packageId}::spending_vault::${fn}`;

  async function simulate(sender: string, build: (tx: Transaction) => void): Promise<Outcome> {
    try {
      const tx = new Transaction();
      tx.setSender(sender);
      build(tx);
      const result = await client.simulateTransaction({ transaction: tx, include: { effects: true } });
      if (result.$kind === "Transaction") return { ok: true };
      return { ok: false, reason: result.FailedTransaction.status.error?.message ?? "failed" };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  function abortName(reason: string): string | null {
    const match = reason.match(/spending_vault[^\n]*?(?:abort|code)[^\d]*(\d+)/i) ?? reason.match(/\b(?:abort code|code):?\s*(\d+)/i);
    return match ? (ABORT_NAMES[match[1]] ?? `abort ${match[1]}`) : null;
  }

  let failures = 0;
  function report(name: string, layer: string, outcome: Outcome, expect: "rejected" | "allowed", detail?: string) {
    const rejected = !outcome.ok;
    const pass = expect === "rejected" ? rejected : !rejected;
    if (!pass) failures += 1;
    const what = outcome.ok ? "succeeded" : `rejected${abortName(outcome.reason) ? ` (${abortName(outcome.reason)})` : ""}`;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      layer: ${layer} | expected ${expect}, got ${what}`);
    if (detail) console.log(`      note: ${detail}`);
    if (!outcome.ok && process.env.VERBOSE) console.log(`      raw: ${outcome.reason}`);
  }

  console.log(`Vault ${config.vaultId}`);
  console.log(`Agent wallet ${agent} | paused: ${status.paused} | allowed validators: ${status.allowedValidators.length}\n`);

  const stakeArgs = (tx: Transaction, validator: string, amount: bigint) =>
    tx.moveCall({
      target: target("stake"),
      arguments: [
        tx.object(config.agentCapId),
        tx.object(config.vaultId),
        tx.object(SUI_SYSTEM_STATE_OBJECT_ID),
        tx.pure.address(validator),
        tx.pure.u64(amount),
      ],
    });
  const spendArgs = (tx: Transaction, recipient: string, amount: bigint) =>
    tx.moveCall({
      target: target("spend"),
      arguments: [tx.object(config.agentCapId), tx.object(config.vaultId), tx.pure.address(recipient), tx.pure.u64(amount)],
    });

  if (expectPaused) {
    console.log("--- Owner has paused the vault ---");
    report(
      "Agent stakes with an allowed validator while paused",
      "contract",
      await simulate(agent, (tx) => stakeArgs(tx, allowed, parseToMist("1"))),
      "rejected",
    );
    report(
      "Agent spends 0.01 SUI while paused",
      "contract",
      await simulate(agent, (tx) => spendArgs(tx, SOME_RECIPIENT, parseToMist("0.01"))),
      "rejected",
    );
    process.exit(failures ? 1 : 0);
  }

  console.log("--- Contract rules (the agent bypassing every client-side check) ---");
  report(
    "Stake with a validator the owner did not allow",
    "contract",
    await simulate(agent, (tx) => stakeArgs(tx, NON_ALLOWED_VALIDATOR, parseToMist("1"))),
    "rejected",
  );
  report(
    "Spend over the per-spend limit (0.2 SUI vs 0.1 limit)",
    "contract",
    await simulate(agent, (tx) => spendArgs(tx, SOME_RECIPIENT, parseToMist("0.2"))),
    "rejected",
  );
  report(
    "Stake more than the vault holds",
    "contract",
    await simulate(agent, (tx) => stakeArgs(tx, allowed, status.balanceMist + parseToMist("1"))),
    "rejected",
    "the spend version of this check is shadowed by the per-spend limit, so it is covered by the Move unit tests",
  );
  if (status.balanceMist >= parseToMist("1")) {
    report(
      "Stake 1 SUI with an allowed validator (above the 0.1 per-spend limit)",
      "contract",
      await simulate(agent, (tx) => stakeArgs(tx, allowed, parseToMist("1"))),
      "allowed",
      "staking has no per-spend limit by design: the funds stay in the vault and only the owner can unstake",
    );
  } else {
    console.log("SKIP  stake-above-limit check: the vault holds under 1 SUI (a live 1 SUI stake already succeeded)");
  }

  console.log("\n--- The agent trying to use owner powers ---");
  const ownerOnly: Array<[string, (tx: Transaction) => void]> = [
    [
      "Unstake, passing the AgentCap where the OwnerCap is required",
      (tx) =>
        tx.moveCall({
          target: target("unstake"),
          arguments: [
            tx.object(config.agentCapId),
            tx.object(config.vaultId),
            tx.object(SUI_SYSTEM_STATE_OBJECT_ID),
            tx.pure.id(receipt ?? config.vaultId),
          ],
        }),
    ],
    [
      "Withdraw funds to itself with the AgentCap",
      (tx) =>
        tx.moveCall({
          target: target("withdraw"),
          arguments: [tx.object(config.agentCapId), tx.object(config.vaultId), tx.pure.u64(1)],
        }),
    ],
    [
      "Raise the per-spend limit with the AgentCap",
      (tx) =>
        tx.moveCall({
          target: target("set_per_tx_limit"),
          arguments: [tx.object(config.agentCapId), tx.object(config.vaultId), tx.pure.u64(parseToMist("1000"))],
        }),
    ],
    [
      "Unpause the vault with the AgentCap",
      (tx) =>
        tx.moveCall({
          target: target("set_paused"),
          arguments: [tx.object(config.agentCapId), tx.object(config.vaultId), tx.pure.bool(false)],
        }),
    ],
    [
      "Add its own validator to the allowlist with the AgentCap",
      (tx) =>
        tx.moveCall({
          target: target("allow_validator"),
          arguments: [tx.object(config.agentCapId), tx.object(config.vaultId), tx.pure.address(NON_ALLOWED_VALIDATOR)],
        }),
    ],
  ];
  for (const [name, build] of ownerOnly) {
    report(name, "Move type system", await simulate(agent, build), "rejected");
  }

  console.log("\n--- Reaching around the vault ---");
  if (receipt) {
    report(
      "Take the StakedSui receipt out of the vault and withdraw it from the staking system directly",
      "Sui object ownership",
      await simulate(agent, (tx) => {
        const returned = tx.moveCall({
          target: "0x3::sui_system::request_withdraw_stake_non_entry",
          arguments: [tx.object(SUI_SYSTEM_STATE_OBJECT_ID), tx.object(receipt)],
        });
        tx.moveCall({ target: "0x2::coin::from_balance", typeArguments: ["0x2::sui::SUI"], arguments: [returned] });
      }),
      "rejected",
    );
  } else {
    console.log("SKIP  receipt withdraw test: the vault holds no staking receipt");
  }
  report(
    "Someone else uses the agent's AgentCap object ID",
    "Sui object ownership",
    await simulate(NOT_THE_AGENT, (tx) => spendArgs(tx, SOME_RECIPIENT, parseToMist("0.01"))),
    "rejected",
    "a leaked cap ID is useless without the agent's key",
  );

  console.log("\n--- Known gap, expected to succeed today ---");
  report(
    "Spend 0.01 SUI to ANY address (no recipient allowlist yet)",
    "contract",
    await simulate(agent, (tx) => spendArgs(tx, "0x00000000000000000000000000000000000000000000000000000000000dead0", parseToMist("0.01"))),
    "allowed",
    "within the per-spend limit the agent can pay anyone, repeatedly: there is no daily cap or recipient allowlist",
  );

  console.log(`\n${failures === 0 ? "All boundaries behaved as expected." : `${failures} check(s) did not behave as expected.`}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
