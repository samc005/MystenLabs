/**
 * Security boundary checks. Plays the agent (and a thief) against the live testnet vault
 * and reports whether each attack is rejected, and by which layer.
 *
 * Every attempt is a SIMULATION: nothing is signed or submitted. The wallet-mcp
 * client-side checks are skipped on purpose so the attempts reach the contract.
 *
 *   npm run boundaries
 *   npm run boundaries -- --expect-paused   (run while the owner has paused the vault)
 *   npm run boundaries -- --live-intent     (also signs two cheap owner transactions: creates an
 *                                            intent with an impossible price floor, then cancels it)
 */
import { Transaction } from "@mysten/sui/transactions";
import { parseToMist, SUI_SYSTEM_STATE_OBJECT_ID } from "@mysten/sui/utils";
import { createSuiClient } from "../blockchain/client.js";
import { cancelIntent, createIntent, loadOwnerContext } from "../blockchain/owner.js";
import { getDex } from "../blockchain/dex.js";
import { resolveCoinType } from "../blockchain/coins.js";
import { getVaultStatus, ruleFloor, spendCapRemaining } from "../blockchain/vault.js";
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
  "7": "EZeroAmount",
  "8": "EIntentNotFound",
  "9": "EIntentExpired",
  "10": "EInsufficientTrading",
  "11": "EBelowMinOut",
  "12": "EBadExpiry",
  "13": "EDailyCapExceeded",
  "14": "ERecipientNotAllowed",
  "15": "ESpendIntentNotFound",
  "16": "ESpendIntentExpired",
  "17": "EStakeCapExceeded",
  "18": "EBelowReserve",
  "19": "ETooManyPositions",
  "20": "EPolicyNotSet",
  "21": "ENoTradeRule",
  "22": "ETradeRuleExpired",
  "23": "ETradeTooLarge",
  "24": "ETradeEpochCapExceeded",
  "25": "ERateBelowFloor",
  "26": "EBadRule",
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

  console.log("\n--- Swaps: the agent bypassing every client-side check ---");
  const SUI = resolveCoinType("sui");
  const USDC = resolveCoinType("usdc");
  const swapPtb = (tx: Transaction, intentId: string) => {
    const typeArguments = [SUI, USDC];
    const [coinIn, ticket] = tx.moveCall({
      target: target("begin_swap"),
      typeArguments,
      arguments: [tx.object(config.agentCapId), tx.object(config.vaultId), tx.pure.id(intentId), tx.object.clock()],
    });
    const coinOut = getDex().addSwap(tx, coinIn!, SUI, USDC);
    tx.moveCall({ target: target("finish_swap"), typeArguments, arguments: [ticket!, tx.object(config.vaultId), coinOut] });
  };
  report(
    "Run a trade the owner never approved (made-up intent ID)",
    "contract",
    await simulate(agent, (tx) => swapPtb(tx, "0x00000000000000000000000000000000000000000000000000000000000dead1")),
    "rejected",
    "with no on-chain intent the agent cannot take a single coin out of the trading sleeve",
  );
  const swapOwnerOnly: Array<[string, (tx: Transaction) => void]> = [
    [
      "Approve its own trade: create_intent with the AgentCap",
      (tx) =>
        tx.moveCall({
          target: target("create_intent"),
          typeArguments: [SUI, USDC],
          arguments: [
            tx.object(config.agentCapId),
            tx.object(config.vaultId),
            tx.pure.u64(1),
            tx.pure.u64(1),
            tx.pure.u64(Date.now() + 600_000),
            tx.object.clock(),
          ],
        }),
    ],
    [
      "Move funds into the trading sleeve with the AgentCap",
      (tx) =>
        tx.moveCall({
          target: target("allocate_sui_to_trading"),
          arguments: [tx.object(config.agentCapId), tx.object(config.vaultId), tx.pure.u64(1)],
        }),
    ],
    [
      "Withdraw from the trading sleeve with the AgentCap",
      (tx) =>
        tx.moveCall({
          target: target("withdraw_trading"),
          typeArguments: [SUI],
          arguments: [tx.object(config.agentCapId), tx.object(config.vaultId), tx.pure.u64(1)],
        }),
    ],
  ];
  for (const [name, build] of swapOwnerOnly) {
    report(name, "Move type system", await simulate(agent, build), "rejected");
  }

  if (process.argv.includes("--live-intent")) {
    console.log("\n--- Live: the owner's price floor (signs two small owner transactions) ---");
    const ctx = await loadOwnerContext(client, network);
    const created = await createIntent(ctx, { inType: SUI, outType: USDC, amountIn: parseToMist("0.01"), minOut: 1_000_000_000n, ttlMs: 120_000 });
    console.log(`      created intent ${created.intentId} (sell 0.01 SUI, demand 1000 tUSDC: far above the pool's price)`);
    try {
      report(
        "Execute an approved trade that returns less than the owner's minimum",
        "contract",
        await simulate(agent, (tx) => swapPtb(tx, created.intentId)),
        "rejected",
        "the intent is real and open, the pool swap works, but finish_swap refuses output below min_out",
      );
    } finally {
      await cancelIntent(ctx, created.intentId);
      console.log(`      cancelled intent ${created.intentId}`);
    }
  } else {
    console.log("SKIP  owner price-floor check (run with --live-intent to include it)");
  }

  // --- Owner policies ---
  // Which checks apply depends on what the owner has configured on this vault.
  const STRANGER = "0x00000000000000000000000000000000000000000000000000000000000dead0";
  const rule = status.tradeRules.find((r) => r.inType === SUI && r.outType === USDC);

  console.log("\n--- Owner policies: the agent trying to change them ---");
  const policyOwnerOnly: Array<[string, (tx: Transaction) => void]> = [
    [
      "Raise its own spending cap: set_spend_policy with the AgentCap",
      (tx) =>
        tx.moveCall({
          target: target("set_spend_policy"),
          arguments: [tx.object(config.agentCapId), tx.object(config.vaultId), tx.pure.u64(parseToMist("1000")), tx.pure.bool(false)],
        }),
    ],
    [
      "Remove the spending policy: clear_spend_policy with the AgentCap",
      (tx) => tx.moveCall({ target: target("clear_spend_policy"), arguments: [tx.object(config.agentCapId), tx.object(config.vaultId)] }),
    ],
    [
      "Allowlist its own address: allow_recipient with the AgentCap",
      (tx) =>
        tx.moveCall({
          target: target("allow_recipient"),
          arguments: [tx.object(config.agentCapId), tx.object(config.vaultId), tx.pure.address(agent)],
        }),
    ],
    [
      "Loosen the stake limits: set_stake_policy with the AgentCap",
      (tx) =>
        tx.moveCall({
          target: target("set_stake_policy"),
          arguments: [
            tx.object(config.agentCapId),
            tx.object(config.vaultId),
            tx.pure.u64(parseToMist("1000")),
            tx.pure.u64(0),
            tx.pure.u64(1000),
          ],
        }),
    ],
    [
      "Zero the stake counters: sync_stake_counters with the AgentCap",
      (tx) =>
        tx.moveCall({
          target: target("sync_stake_counters"),
          arguments: [tx.object(config.agentCapId), tx.object(config.vaultId), tx.pure.u64(0), tx.pure.u64(0)],
        }),
    ],
    [
      "Approve its own payment: create_spend_intent with the AgentCap",
      (tx) =>
        tx.moveCall({
          target: target("create_spend_intent"),
          arguments: [
            tx.object(config.agentCapId),
            tx.object(config.vaultId),
            tx.pure.address(STRANGER),
            tx.pure.u64(parseToMist("0.01")),
            tx.pure.u64(Date.now() + 600_000),
            tx.object.clock(),
          ],
        }),
    ],
    [
      "Write itself a standing trade rule: set_trade_rule with the AgentCap",
      (tx) =>
        tx.moveCall({
          target: target("set_trade_rule"),
          typeArguments: [SUI, USDC],
          arguments: [
            tx.object(config.agentCapId),
            tx.object(config.vaultId),
            tx.pure.u64(parseToMist("1000")),
            tx.pure.u64(parseToMist("1000")),
            tx.pure.u64(1),
            tx.pure.u64(1_000_000_000),
            tx.pure.u64(Date.now() + 3_600_000),
            tx.object.clock(),
          ],
        }),
    ],
    [
      "Remove the owner's trade rule: remove_trade_rule with the AgentCap",
      (tx) =>
        tx.moveCall({
          target: target("remove_trade_rule"),
          typeArguments: [SUI, USDC],
          arguments: [tx.object(config.agentCapId), tx.object(config.vaultId)],
        }),
    ],
  ];
  for (const [name, build] of policyOwnerOnly) {
    report(name, "Move type system", await simulate(agent, build), "rejected");
  }

  console.log("\n--- Owner policies: spending ---");
  report(
    "Execute a payment approval that does not exist (made-up ID)",
    "contract",
    await simulate(agent, (tx) =>
      tx.moveCall({
        target: target("spend_approved"),
        arguments: [
          tx.object(config.agentCapId),
          tx.object(config.vaultId),
          tx.pure.id("0x00000000000000000000000000000000000000000000000000000000000dead2"),
          tx.object.clock(),
        ],
      }),
    ),
    "rejected",
    "an approved payment is a real on-chain object created by the owner; without one the agent cannot use this path",
  );
  const spendPolicy = status.spendPolicy;
  if (spendPolicy?.enforceRecipients) {
    report(
      "Spend 0.01 SUI to a stranger (not on the recipient allowlist)",
      "contract",
      await simulate(agent, (tx) => spendArgs(tx, STRANGER, parseToMist("0.01"))),
      "rejected",
      "within the per-spend limit, but the owner only allows listed recipients",
    );
    const listed = status.allowedRecipients[0];
    if (listed && spendCapRemaining(status) !== null && (spendCapRemaining(status) ?? 0n) >= parseToMist("0.01")) {
      report(
        "Spend 0.01 SUI to an allowlisted recipient",
        "contract",
        await simulate(agent, (tx) => spendArgs(tx, listed, parseToMist("0.01"))),
        "allowed",
        "a normal payment inside the policy still works with no approval",
      );
    }
  } else {
    report(
      "Spend 0.01 SUI to ANY address",
      "contract",
      await simulate(agent, (tx) => spendArgs(tx, STRANGER, parseToMist("0.01"))),
      "allowed",
      spendPolicy
        ? "this vault has a spending cap but no recipient allowlist, so the agent can pay anyone up to the cap"
        : "KNOWN GAP: this vault has no spending policy, so the agent can pay anyone, repeatedly, up to the per-spend limit",
    );
  }
  if (spendPolicy && spendPolicy.dailyCapMist <= status.perTxLimitMist) {
    report(
      "Spend more than this epoch's cap remaining",
      "contract",
      await simulate(agent, (tx) => spendArgs(tx, status.allowedRecipients[0] ?? STRANGER, (spendCapRemaining(status) ?? 0n) + 1n)),
      "rejected",
    );
  } else {
    console.log("SKIP  epoch-cap check: the cap is above the per-spend limit, so one simulation cannot reach it (covered by the Move unit tests)");
  }

  console.log("\n--- Owner policies: standing trade rule (begin_swap_auto) ---");
  const autoPtb = (tx: Transaction, amountIn: bigint, minOut: bigint, inType = SUI, outType = USDC) => {
    const typeArguments = [inType, outType];
    const [coinIn, ticket] = tx.moveCall({
      target: target("begin_swap_auto"),
      typeArguments,
      arguments: [tx.object(config.agentCapId), tx.object(config.vaultId), tx.pure.u64(amountIn), tx.pure.u64(minOut), tx.object.clock()],
    });
    const coinOut = getDex().addSwap(tx, coinIn!, inType, outType);
    tx.moveCall({ target: target("finish_swap"), typeArguments, arguments: [ticket!, tx.object(config.vaultId), coinOut] });
  };
  report(
    "Swap USDC to SUI with no approval and no rule for that direction",
    "contract",
    await simulate(agent, (tx) => autoPtb(tx, 1_000n, 1n, USDC, SUI)),
    "rejected",
    "a rule covers one direction of one pair; without a rule the agent needs a per-trade approval",
  );
  if (rule) {
    const small = rule.maxPerTrade < parseToMist("0.01") ? rule.maxPerTrade : parseToMist("0.01");
    report(
      "Swap inside the standing rule (agent picks the amount, price above the floor)",
      "contract",
      await simulate(agent, (tx) => autoPtb(tx, small, ruleFloor(rule, small))),
      "allowed",
      `no per-trade approval needed: the owner's rule allows up to ${rule.maxPerTrade} raw per trade at a floor of ${rule.rateNum}/${rule.rateDen}`,
    );
    report(
      "Swap under the rule but demanding almost nothing back (below the owner's price floor)",
      "contract",
      await simulate(agent, (tx) => autoPtb(tx, small, 1n)),
      "rejected",
      "the floor is the owner's number, so the agent cannot pick a terrible price",
    );
    report(
      "Swap larger than the rule's per-trade maximum",
      "contract",
      await simulate(agent, (tx) => autoPtb(tx, rule.maxPerTrade + 1n, ruleFloor(rule, rule.maxPerTrade + 1n))),
      "rejected",
    );
  } else {
    report(
      "Swap SUI to USDC with no approval and no standing rule",
      "contract",
      await simulate(agent, (tx) => autoPtb(tx, parseToMist("0.01"), 1n)),
      "rejected",
      "no rule is set on this vault, so every swap needs a per-trade approval",
    );
    console.log("SKIP  rule-limit checks: this vault has no SUI to tUSDC standing rule");
  }

  console.log("\n--- Owner policies: staking ---");
  if (status.stakePolicy) {
    const kp = status.stakePolicy;
    console.log(
      `      stake policy: max ${kp.maxStakedMist} MIST staked (${kp.stakedTotalMist} now), reserve ${kp.minReserveMist}, positions ${kp.positions}/${kp.maxPositions}`,
    );
    console.log("SKIP  stake-cap live checks: the vault's balance is below the 1 SUI minimum stake, so a simulation would fail on balance first (covered by the Move unit tests)");
  } else {
    console.log("NOTE  this vault has no stake policy: the agent can stake the whole balance in any number of positions");
  }

  console.log(`\n${failures === 0 ? "All boundaries behaved as expected." : `${failures} check(s) did not behave as expected.`}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
