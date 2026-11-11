// Owner-only actions. Needs the key that holds the vault's OwnerCap (read from the
// Sui CLI keystore). The agent and the MCP server cannot reach this script.

import { createSuiClient } from "../blockchain/client.js";
import { formatAmount, getCoinInfo, parseUnits, resolveCoinType } from "../blockchain/coins.js";
import {
  allocateSui,
  allowValidator,
  approveProposal,
  cancelIntent,
  createIntent,
  depositTrading,
  loadOwnerContext,
  rejectProposal,
  releaseSui,
  setPoolPrice,
  unstake,
  withdrawTrading,
  type OwnerReceipt,
} from "../blockchain/owner.js";
import { describeProposal, listProposals } from "../blockchain/proposals.js";
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
  approve <proposalId>                   approve a proposal (signs create_intent)
  reject <proposalId>                    reject a proposal
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
      printReceipt("Approved on-chain. The agent can now run this trade once.", receipt);
      console.log(describeProposal(proposal));
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
