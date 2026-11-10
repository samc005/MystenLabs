import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { assertTestnet, explorerTxUrl } from "../config.js";
import type { SuiNetwork } from "./client.js";

export async function executeWalletTransaction(input: {
  client: SuiGrpcClient;
  network: SuiNetwork;
  signer: Ed25519Keypair;
  transaction: Transaction;
}): Promise<string> {
  assertTestnet(input.network);
  const submitted = await input.client.signAndExecuteTransaction({
    transaction: input.transaction,
    signer: input.signer,
    include: { effects: true, balanceChanges: true },
  });
  if (submitted.$kind === "FailedTransaction") {
    throw new Error(submitted.FailedTransaction.status.error?.message ?? "Transaction failed.");
  }
  const settled = await input.client.waitForTransaction({
    result: submitted,
    include: { effects: true, balanceChanges: true },
    timeout: 60_000,
  });
  if (settled.$kind === "FailedTransaction") {
    throw new Error(settled.FailedTransaction.status.error?.message ?? "Transaction failed.");
  }
  return settled.Transaction.digest;
}

export function writeReceipt(network: SuiNetwork, digest: string, summary: string): string {
  return `${summary}\nDigest: ${digest}\nExplorer: ${explorerTxUrl(network, digest)}`;
}
