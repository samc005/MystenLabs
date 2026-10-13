// Usage: npm run transfer -- <recipient> <amount>
// Example: npm run transfer -- 0xabc... 0.01

import { parseToMist } from "@mysten/sui/utils";
import { createSuiClient } from "../blockchain/client.js";
import { formatTransferReceipt, transferSui } from "../blockchain/transfer.js";
import { requireWallet } from "../blockchain/wallet.js";
import { resolveNetwork } from "../config.js";

async function main() {
  const [recipient, amount] = process.argv.slice(2);
  if (!recipient || !amount) {
    throw new Error('Usage: npm run transfer -- <recipient> <amount>\nExample: npm run transfer -- 0xabc... 0.01');
  }
  let amountMist: bigint;
  try {
    amountMist = parseToMist(amount);
  } catch {
    throw new Error(`Amount must be a positive SUI decimal string, for example "0.01". Got "${amount}".`);
  }

  const network = resolveNetwork();
  const wallet = await requireWallet(network);
  const receipt = await transferSui({
    client: createSuiClient(network),
    network,
    signer: wallet.keypair,
    recipient,
    amountMist,
  });
  console.log(formatTransferReceipt(receipt));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
