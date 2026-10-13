// Usage: npm run setup
// Creates .wallet/sender.json on testnet (mode 0600) and requests faucet SUI if the balance is 0.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SUI_DECIMALS } from "@mysten/sui/utils";
import { formatUnits, formatBalanceReport, getAllBalances, getBalance } from "../blockchain/balance.js";
import { createSuiClient } from "../blockchain/client.js";
import { fundFromFaucet, waitForFaucet } from "../blockchain/faucet.js";
import { loadOrCreateWallet } from "../blockchain/wallet.js";
import { explorerTxUrl, resolveNetwork } from "../config.js";

export async function ensureFundedWallet() {
  const network = resolveNetwork();
  const wallet = await loadOrCreateWallet(network);
  const client = createSuiClient(network);

  console.log(wallet.created ? `Created testnet wallet: ${wallet.address}` : `Using wallet: ${wallet.address}`);
  console.log(`Key file: ${wallet.filePath}`);

  let balance = await getBalance(client, wallet.address);
  if (balance.raw === 0n) {
    console.log("Balance is 0. Requesting testnet SUI from the faucet (proof-of-work, this can take a minute)...");
    const faucet = await fundFromFaucet(network, wallet.address);
    console.log(
      `Faucet credited ${formatUnits(faucet.amountMist, SUI_DECIMALS)} SUI. Digest: ${faucet.digest}`,
    );
    console.log(explorerTxUrl(network, faucet.digest));
    await waitForFaucet(client, faucet.digest);
    balance = await getBalance(client, wallet.address);
  }

  const balances = await getAllBalances(client, wallet.address);
  console.log(formatBalanceReport(network, wallet.address, balances));
  return { network, wallet, client, balance };
}

async function main() {
  await ensureFundedWallet();
}

const isDirectRun =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
