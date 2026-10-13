// Creates a sender and a receiver on testnet, funds the sender, and sends 0.01 SUI.

import { parseToMist } from "@mysten/sui/utils";
import { formatBalanceReport, getAllBalances } from "../blockchain/balance.js";
import { createSuiClient } from "../blockchain/client.js";
import { formatTransferReceipt, transferSui } from "../blockchain/transfer.js";
import { loadOrCreateWallet } from "../blockchain/wallet.js";
import { ensureFundedWallet } from "./setup.js";

const DEMO_AMOUNT = "0.01";

async function main() {
  const { network, wallet: sender, client } = await ensureFundedWallet();

  const receiver = await loadOrCreateWallet(network, "receiver");
  console.log(
    receiver.created ? `Created receiver: ${receiver.address}` : `Using receiver: ${receiver.address}`,
  );

  console.log(`Sending ${DEMO_AMOUNT} SUI...`);
  const receipt = await transferSui({
    client,
    network,
    signer: sender.keypair,
    recipient: receiver.address,
    amountMist: parseToMist(DEMO_AMOUNT),
  });
  console.log(formatTransferReceipt(receipt));

  const refreshed = createSuiClient(network);
  console.log("\nSender after transfer:");
  console.log(formatBalanceReport(network, sender.address, await getAllBalances(refreshed, sender.address)));
  console.log("\nReceiver after transfer:");
  console.log(
    formatBalanceReport(network, receiver.address, await getAllBalances(refreshed, receiver.address)),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
