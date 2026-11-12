// Owner-only actions. Needs the key that holds the vault's OwnerCap (read from the
// Sui CLI keystore). The agent and the MCP server cannot reach this script.

import { createSuiClient } from "../blockchain/client.js";
import { formatAmount, getCoinInfo, parseUnits, resolveCoinType } from "../blockchain/coins.js";
import {
  allocateSui,
  allowValidator,
  approveProposal,
  cancelIntent,
  cancelSpendIntent,
  clearSpendPolicy,
  clearStakePolicy,
  createIntent,
  createSpendIntent,
  depositTrading,
  loadOwnerContext,
  rateToRaw,
  rejectProposal,
  releaseSui,
  removeTradeRule,
  setPoolPrice,
  setRecipientAllowed,
  setSpendPolicy,
  setStakePolicy,
  setTradeRule,
  unstake,
  withdrawTrading,
  type OwnerReceipt,
} from "../blockchain/owner.js";
import { describeProposal, isSpendProposal, listProposals } from "../blockchain/proposals.js";
import { formatVaultStatus, getVaultStatus } from "../blockchain/vault.js";
import { resolveNetwork } from "../config.js";

const USAGE = `Usage: npm run owner -- <command>

  status                                 vault balances, sleeve, approved trades
  allocate <sui>                         move SUI from the vault into the trading sleeve
  release <sui>                          move SUI back from the sleeve to the vault balance
  deposit <coin> <amount>                add coins from your wallet to the sleeve (SUI, tUSDC)
  withdraw <coin> <amount>               take coins from the sleeve to your wallet
  intent <sell> <buy> <amount> <minOut> [ttlMinutes]
                                         approve one trade directly, e.g. intent SUI tUSDC 0.5 0.9 10
  cancel <intentId>                      withdraw approval for a trade
  proposals                              list trades the agent proposed in chat
  approve <proposalId>                   approve a proposal (a swap, or a payment outside the policy)
  reject <proposalId>                    reject a proposal
  spend-intent <to> <sui> [ttlMinutes]   approve one payment directly, to this recipient and amount only
  cancel-spend <intentId>                withdraw approval for a payment
  spend-policy <sui-per-epoch> [any|allowlist]
                                         cap direct spending per epoch (~1 day); 'allowlist' also limits who can be paid
  clear-spend-policy                     remove the spending cap and allowlist requirement
  allow-recipient <address>              add to the recipient allowlist
  disallow-recipient <address>
  stake-policy <maxStakedSui> <reserveSui> <maxPositions>
                                         cap staking: total staked, SUI that must stay liquid, number of positions
  clear-stake-policy                     remove the stake limits
  trade-rule <sell> <buy> <maxPerTrade> <maxPerEpoch> <minPrice> [ttlHours]
                                         let the agent swap with no per-trade approval inside these limits.
                                         minPrice is the least you accept: <buy> per 1 <sell>, e.g. trade-rule SUI tUSDC 0.5 1 1.5 24
  remove-trade-rule <sell> <buy>         end a standing trade rule
  allow-validator <address>              let the agent stake with a validator
  disallow-validator <address>
  unstake <stakedSuiId>                  unstake a position (funds return to the vault)
  pool-price <tUSDC-per-SUI>             move the testnet mock pool's price`;

function printReceipt(label: string, receipt: OwnerReceipt) {
  console.log(label);
  console.log(`Digest: ${receipt.digest}`);
  console.log(`Explorer: ${receipt.explorerUrl}`);
  if (receipt.gasMist !== null) console.log(`Gas: ${formatAmount(receipt.gasMist, { decimals: 9, symbol: "SUI" })}`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error(USAGE);
  const network = resolveNetwork();
  const client = createSuiClient(network);

  // Commands that only read or only edit local proposal files need no key.
  if (command === "status") {
    console.log(formatVaultStatus(await getVaultStatus(client)));
    return;
  }
  if (command === "proposals") {
    const proposals = await listProposals(20);
    console.log(proposals.length ? proposals.map(describeProposal).join("\n\n") : "No proposals.");
    return;
  }
  if (command === "reject") {
    const [id] = args;
    if (!id) throw new Error(USAGE);
    console.log(describeProposal(await rejectProposal(id)));
    return;
  }

  const ctx = await loadOwnerContext(client, network);
  console.log(`Owner key: ${ctx.address}`);

  switch (command) {
    case "allocate": {
      const [amount] = args;
      if (!amount) throw new Error(USAGE);
      const mist = parseUnits(amount, 9);
      printReceipt(`Allocated ${amount} SUI to the trading sleeve.`, await allocateSui(ctx, mist));
      return;
    }
    case "release": {
      const [amount] = args;
      if (!amount) throw new Error(USAGE);
      printReceipt(`Released ${amount} SUI from the sleeve.`, await releaseSui(ctx, parseUnits(amount, 9)));
      return;
    }
    case "deposit":
    case "withdraw": {
      const [coin, amount] = args;
      if (!coin || !amount) throw new Error(USAGE);
      const coinType = resolveCoinType(coin);
      const info = await getCoinInfo(client, coinType);
      const raw = parseUnits(amount, info.decimals);
      const receipt = command === "deposit" ? await depositTrading(ctx, coinType, raw) : await withdrawTrading(ctx, coinType, raw);
      printReceipt(`${command === "deposit" ? "Deposited" : "Withdrew"} ${formatAmount(raw, info)}.`, receipt);
      return;
    }
    case "intent": {
      const [sell, buy, amount, minOut, ttl] = args;
      if (!sell || !buy || !amount || !minOut) throw new Error(USAGE);
      const inType = resolveCoinType(sell);
      const outType = resolveCoinType(buy);
      const [inInfo, outInfo] = await Promise.all([getCoinInfo(client, inType), getCoinInfo(client, outType)]);
      const ttlMinutes = ttl ? Number(ttl) : 5;
      if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) throw new Error("ttlMinutes must be a positive number.");
      const receipt = await createIntent(ctx, {
        inType,
        outType,
        amountIn: parseUnits(amount, inInfo.decimals),
        minOut: parseUnits(minOut, outInfo.decimals),
        ttlMs: ttlMinutes * 60_000,
      });
      printReceipt(`Approved: sell ${amount} ${inInfo.symbol} for at least ${minOut} ${outInfo.symbol}.`, receipt);
      console.log(`Intent: ${receipt.intentId}`);
      console.log(`Expires: ${new Date(receipt.expiryMs).toISOString()}`);
      return;
    }
    case "cancel": {
      const [id] = args;
      if (!id) throw new Error(USAGE);
      printReceipt(`Cancelled intent ${id}.`, await cancelIntent(ctx, id));
      return;
    }
    case "approve": {
      const [id] = args;
      if (!id) throw new Error(USAGE);
      const { proposal, receipt } = await approveProposal(ctx, id);
      printReceipt(
        `Approved on-chain. The agent can now run this ${isSpendProposal(proposal) ? "payment" : "trade"} once.`,
        receipt,
      );
      console.log(describeProposal(proposal));
      return;
    }
    case "spend-intent": {
      const [to, amount, ttl] = args;
      if (!to || !amount) throw new Error(USAGE);
      const ttlMinutes = ttl ? Number(ttl) : 5;
      if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) throw new Error("ttlMinutes must be a positive number.");
      const receipt = await createSpendIntent(ctx, {
        recipient: to,
        amountMist: parseUnits(amount, 9),
        ttlMs: ttlMinutes * 60_000,
      });
      printReceipt(`Approved: pay ${amount} SUI to ${to}.`, receipt);
      console.log(`Intent: ${receipt.intentId}`);
      console.log(`Expires: ${new Date(receipt.expiryMs).toISOString()}`);
      return;
    }
    case "cancel-spend": {
      const [id] = args;
      if (!id) throw new Error(USAGE);
      printReceipt(`Cancelled payment approval ${id}.`, await cancelSpendIntent(ctx, id));
      return;
    }
    case "spend-policy": {
      const [cap, mode] = args;
      if (!cap) throw new Error(USAGE);
      if (mode && mode !== "any" && mode !== "allowlist") throw new Error(USAGE);
      const enforceRecipients = mode === "allowlist";
      printReceipt(
        `Spending cap set to ${cap} SUI per epoch. ${enforceRecipients ? "Only allowlisted recipients can be paid directly." : "Any recipient can be paid directly, up to the cap."}`,
        await setSpendPolicy(ctx, { dailyCapMist: parseUnits(cap, 9), enforceRecipients }),
      );
      return;
    }
    case "clear-spend-policy": {
      printReceipt("Removed the spending cap and recipient requirement.", await clearSpendPolicy(ctx));
      return;
    }
    case "allow-recipient":
    case "disallow-recipient": {
      const [recipient] = args;
      if (!recipient) throw new Error(USAGE);
      const allow = command === "allow-recipient";
      printReceipt(
        `${allow ? "Allowed" : "Removed"} recipient ${recipient}.`,
        await setRecipientAllowed(ctx, recipient, allow),
      );
      return;
    }
    case "stake-policy": {
      const [maxStaked, reserve, positions] = args;
      if (!maxStaked || !reserve || !positions) throw new Error(USAGE);
      const maxPositions = BigInt(positions);
      printReceipt(
        `Stake policy set: at most ${maxStaked} SUI staked, ${reserve} SUI kept liquid, at most ${maxPositions} positions. Counters synced to the vault's actual stakes.`,
        await setStakePolicy(ctx, {
          maxStakedMist: parseUnits(maxStaked, 9),
          minReserveMist: parseUnits(reserve, 9),
          maxPositions,
        }),
      );
      return;
    }
    case "clear-stake-policy": {
      printReceipt("Removed the stake limits.", await clearStakePolicy(ctx));
      return;
    }
    case "trade-rule": {
      const [sell, buy, maxTrade, maxEpoch, minPrice, ttl] = args;
      if (!sell || !buy || !maxTrade || !maxEpoch || !minPrice) throw new Error(USAGE);
      const inType = resolveCoinType(sell);
      const outType = resolveCoinType(buy);
      const [inInfo, outInfo] = await Promise.all([getCoinInfo(client, inType), getCoinInfo(client, outType)]);
      const ttlHours = ttl ? Number(ttl) : 24;
      if (!Number.isFinite(ttlHours) || ttlHours <= 0) throw new Error("ttlHours must be a positive number.");
      const { num, den } = rateToRaw(minPrice, inInfo.decimals, outInfo.decimals);
      const receipt = await setTradeRule(ctx, {
        inType,
        outType,
        maxPerTrade: parseUnits(maxTrade, inInfo.decimals),
        maxPerEpoch: parseUnits(maxEpoch, inInfo.decimals),
        rateNum: num,
        rateDen: den,
        ttlMs: ttlHours * 3_600_000,
      });
      printReceipt(
        `Standing rule: the agent may sell up to ${maxTrade} ${inInfo.symbol} per trade and ${maxEpoch} ${inInfo.symbol} per epoch for ${outInfo.symbol}, never below ${minPrice} ${outInfo.symbol} per ${inInfo.symbol}.`,
        receipt,
      );
      console.log(`Expires: ${new Date(receipt.expiryMs).toISOString()}`);
      console.log(`The price floor is your number. The contract has no price oracle, so keep it near the market and keep the limits small.`);
      return;
    }
    case "remove-trade-rule": {
      const [sell, buy] = args;
      if (!sell || !buy) throw new Error(USAGE);
      printReceipt(`Removed the ${sell} -> ${buy} rule.`, await removeTradeRule(ctx, resolveCoinType(sell), resolveCoinType(buy)));
      return;
    }
    case "allow-validator":
    case "disallow-validator": {
      const [validator] = args;
      if (!validator) throw new Error(USAGE);
      const allow = command === "allow-validator";
      printReceipt(`${allow ? "Allowed" : "Removed"} validator ${validator}.`, await allowValidator(ctx, validator, allow));
      return;
    }
    case "unstake": {
      const [id] = args;
      if (!id) throw new Error(USAGE);
      printReceipt(`Unstaked ${id}. Funds returned to the vault balance.`, await unstake(ctx, id));
      return;
    }
    case "pool-price": {
      const [price] = args;
      if (!price) throw new Error(USAGE);
      const receipt = await setPoolPrice(ctx, price);
      printReceipt(`Mock pool price set to ${price} tUSDC per SUI.`, receipt);
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
