import { parseToMist } from "@mysten/sui/utils";
import { createSuiClient } from "../blockchain/client.js";
import {
  dryRunVaultSpend,
  dryRunVaultStake,
  formatVaultDryRun,
  formatVaultSpendReceipt,
  formatVaultStakeDryRun,
  formatVaultStakeReceipt,
  formatVaultStatus,
  getVaultStatus,
  vaultSpend,
  vaultStake,
} from "../blockchain/vault.js";
import { dryRunSwap, executeProposal, formatQuote, formatSwapDryRun, formatSwapReceipt, quoteSwap, vaultSwap } from "../blockchain/swap.js";
import { formatValidators, listValidators } from "../blockchain/validators.js";
import { requireWallet } from "../blockchain/wallet.js";
import { resolveNetwork } from "../config.js";

const USAGE = `Usage:
  npm run vault -- status
  npm run vault -- spend <recipient> <amountSui> [--dry-run]
  npm run vault -- stake <validator> <amountSui> [--dry-run]
  npm run vault -- validators
  npm run vault -- quote <sell> <buy> <amount>
  npm run vault -- swap <proposalId|intentId> [--dry-run]   (runs a trade the owner approved)`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const network = resolveNetwork();
  const client = createSuiClient(network);

  if (command === "status") {
    console.log(formatVaultStatus(await getVaultStatus(client)));
    return;
  }

  if (command === "spend") {
    const dryRun = rest.includes("--dry-run");
    const [to, amount] = rest.filter((arg) => arg !== "--dry-run");
    if (!to || !amount) throw new Error(USAGE);
    const wallet = await requireWallet(network);
    const input = {
      client,
      network,
      signer: wallet.keypair,
      recipient: to,
      amountMist: parseToMist(amount),
    };
    if (dryRun) {
      console.log(formatVaultDryRun(await dryRunVaultSpend({ ...input, sender: wallet.address })));
    } else {
      console.log(formatVaultSpendReceipt(await vaultSpend(input)));
    }
    return;
  }

  if (command === "stake") {
    const dryRun = rest.includes("--dry-run");
    const [validator, amount] = rest.filter((arg) => arg !== "--dry-run");
    if (!validator || !amount) throw new Error(USAGE);
    const wallet = await requireWallet(network);
    const input = {
      client,
      network,
      signer: wallet.keypair,
      validator,
      amountMist: parseToMist(amount),
    };
    if (dryRun) {
      console.log(formatVaultStakeDryRun(await dryRunVaultStake({ ...input, sender: wallet.address })));
    } else {
      console.log(formatVaultStakeReceipt(await vaultStake(input)));
    }
    return;
  }

  if (command === "validators") {
    const [{ epoch, validators }, status] = await Promise.all([listValidators(network), getVaultStatus(client)]);
    console.log(formatValidators(epoch, validators, status.allowedValidators));
    return;
  }

  if (command === "quote") {
    const [sell, buy, amount] = rest;
    if (!sell || !buy || !amount) throw new Error(USAGE);
    console.log(formatQuote(await quoteSwap(client, sell, buy, amount)));
    return;
  }

  if (command === "swap") {
    const dryRun = rest.includes("--dry-run");
    const [id] = rest.filter((arg) => arg !== "--dry-run");
    if (!id) throw new Error(USAGE);
    const wallet = await requireWallet(network);
    if (id.startsWith("prop_")) {
      const { text } = await executeProposal({ client, network, signer: wallet.keypair, proposalId: id, dryRun });
      console.log(text);
      return;
    }
    const input = { client, network, signer: wallet.keypair, intentId: id };
    console.log(dryRun ? formatSwapDryRun(await dryRunSwap({ ...input, sender: input.signer.toSuiAddress() })) : formatSwapReceipt(await vaultSwap(input)));
    return;
  }

  throw new Error(USAGE);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
