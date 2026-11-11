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
import { requireWallet } from "../blockchain/wallet.js";
import { resolveNetwork } from "../config.js";

const USAGE = `Usage:
  npm run vault -- status
  npm run vault -- spend <recipient> <amountSui> [--dry-run]
  npm run vault -- stake <validator> <amountSui> [--dry-run]`;

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

  throw new Error(USAGE);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
