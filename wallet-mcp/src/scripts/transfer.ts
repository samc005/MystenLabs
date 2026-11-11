// Usage: npm run transfer -- <recipient> <amount> [--dry-run]
// Example: npm run transfer -- 0xabc... 0.01 --dry-run

import { parseToMist } from "@mysten/sui/utils";
import { createSuiClient } from "../blockchain/client.js";
import { dryRunTransferSui, formatDryRun, formatTransferReceipt, transferSui } from "../blockchain/transfer.js";
import { requireWallet } from "../blockchain/wallet.js";
import { resolveNetwork } from "../config.js";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const [recipient, amount] = args.filter((arg) => arg !== "--dry-run");
  if (!recipient || !amount) {
    throw new Error(
      "Usage: npm run transfer -- <recipient> <amount> [--dry-run]\nExample: npm run transfer -- 0xabc... 0.01 --dry-run",
    );
  }
  let amountMist: bigint;
  try {
    amountMist = parseToMist(amount);
  } catch {
    throw new Error(`Amount must be a positive SUI decimal string, for example "0.01". Got "${amount}".`);
  }

  const network = resolveNetwork();
  const wallet = await requireWallet(network);
  const input = {
    client: createSuiClient(network),
    network,
    signer: wallet.keypair,
    recipient,
    amountMist,
  };
  if (dryRun) {
    console.log(formatDryRun(await dryRunTransferSui({ ...input, sender: wallet.address })));
    return;
  }
  console.log(formatTransferReceipt(await transferSui(input)));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
