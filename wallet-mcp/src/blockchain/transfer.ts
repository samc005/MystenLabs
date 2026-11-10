import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { SUI_DECIMALS, SUI_TYPE_ARG } from "@mysten/sui/utils";
import { assertTestnet, explorerTxUrl } from "../config.js";
import { formatUnits, getBalance } from "./balance.js";
import type { SuiNetwork } from "./client.js";
import type { TransferReceipt } from "./types.js";
import { requireAddress } from "./wallet.js";

export function netGasMist(gas: {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
}): bigint {
  return BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate);
}

type TransferInput = {
  client: SuiGrpcClient;
  network: SuiNetwork;
  signer: Ed25519Keypair;
  recipient: string;
  amountMist: bigint;
};

/** Validates the request and builds the (unsigned) transfer transaction. */
async function prepareTransfer(input: TransferInput) {
  assertTestnet(input.network);
  if (input.amountMist <= 0n) {
    throw new Error("Amount must be greater than 0.");
  }

  const sender = input.signer.toSuiAddress();
  const recipient = requireAddress(input.recipient);
  if (recipient === sender) {
    throw new Error("Recipient is the sender. Choose a different address.");
  }

  const balance = await getBalance(input.client, sender, SUI_TYPE_ARG);
  if (balance.raw <= input.amountMist) {
    throw new Error(
      `Not enough SUI. Balance is ${balance.formatted} SUI, and the transfer of ${formatUnits(input.amountMist, SUI_DECIMALS)} SUI still needs a little left over for gas.`,
    );
  }

  const tx = new Transaction();
  tx.setSender(sender);
  tx.transferObjects([coinWithBalance({ balance: input.amountMist })(tx)], recipient);
  return { tx, sender, recipient, balance };
}

export type DryRunResult = {
  sender: string;
  recipient: string;
  amountMist: bigint;
  balanceMist: bigint;
  success: boolean;
  error: string | null;
  gasMist: bigint | null;
  gasBreakdown: { computationCost: string; storageCost: string; storageRebate: string } | null;
  balanceChanges: TransferReceipt["balanceChanges"];
};

/** Simulates the transfer on the node. Nothing is signed or submitted. */
export async function dryRunTransferSui(input: TransferInput): Promise<DryRunResult> {
  const { tx, sender, recipient, balance } = await prepareTransfer(input);
  const result = await input.client.simulateTransaction({
    transaction: tx,
    include: { effects: true, balanceChanges: true },
  });
  const outcome = result.$kind === "FailedTransaction" ? result.FailedTransaction : result.Transaction;
  const gas = outcome.effects?.gasUsed ?? null;
  return {
    sender,
    recipient,
    amountMist: input.amountMist,
    balanceMist: balance.raw,
    success: result.$kind === "Transaction",
    error: result.$kind === "FailedTransaction" ? (outcome.status.error?.message ?? "Simulation failed.") : null,
    gasMist: gas ? netGasMist(gas) : null,
    gasBreakdown: gas
      ? {
          computationCost: gas.computationCost,
          storageCost: gas.storageCost,
          storageRebate: gas.storageRebate,
        }
      : null,
    balanceChanges: (outcome.balanceChanges ?? []).map((change) => ({
      address: change.address,
      coinType: change.coinType,
      amount: change.amount,
    })),
  };
}

export function formatDryRun(result: DryRunResult): string {
  const sui = (mist: bigint | string) => formatUnits(BigInt(mist), SUI_DECIMALS);
  const lines = [
    `DRY RUN (nothing was signed or submitted)`,
    `Status: ${result.success ? "would succeed" : `would FAIL: ${result.error}`}`,
    `From: ${result.sender}  (balance ${sui(result.balanceMist)} SUI)`,
    `To: ${result.recipient}`,
    `Amount: ${sui(result.amountMist)} SUI`,
  ];
  if (result.gasBreakdown && result.gasMist !== null) {
    lines.push(
      `Estimated gas: ${sui(result.gasMist)} SUI`,
      `  computation: ${sui(result.gasBreakdown.computationCost)}`,
      `  storage:     ${sui(result.gasBreakdown.storageCost)}`,
      `  rebate:      -${sui(result.gasBreakdown.storageRebate)}`,
    );
  }
  if (result.balanceChanges.length > 0) {
    lines.push("Predicted balance changes:");
    for (const change of result.balanceChanges) {
      lines.push(`  ${sui(change.amount)} SUI  ${change.address}`);
    }
  }
  return lines.join("\n");
}

/**
 * Sends SUI from `signer` to `recipient`, drawing from the address balance
 * (and falling back to coin objects) via coinWithBalance.
 */
export async function transferSui(input: TransferInput): Promise<TransferReceipt> {
  const { tx, sender, recipient } = await prepareTransfer(input);

  const submitted = await input.client.signAndExecuteTransaction({
    transaction: tx,
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

  const executed = settled.Transaction;
  const gas = executed.effects?.gasUsed;
  return {
    digest: executed.digest,
    sender,
    recipient,
    amountMist: input.amountMist,
    gasMist: gas ? netGasMist(gas) : null,
    explorerUrl: explorerTxUrl(input.network, executed.digest),
    balanceChanges: (executed.balanceChanges ?? []).map((change) => ({
      address: change.address,
      coinType: change.coinType,
      amount: change.amount,
    })),
  };
}

export function formatTransferReceipt(receipt: TransferReceipt): string {
  const lines = [
    `Sent ${formatUnits(receipt.amountMist, SUI_DECIMALS)} SUI`,
    `From: ${receipt.sender}`,
    `To: ${receipt.recipient}`,
    `Digest: ${receipt.digest}`,
    `Explorer: ${receipt.explorerUrl}`,
  ];
  if (receipt.gasMist !== null) {
    lines.push(`Gas: ${formatUnits(receipt.gasMist, SUI_DECIMALS)} SUI`);
  }
  if (receipt.balanceChanges.length > 0) {
    lines.push("Balance changes:");
    for (const change of receipt.balanceChanges) {
      lines.push(
        `  ${formatUnits(BigInt(change.amount), SUI_DECIMALS)} ${change.coinType}  ${change.address}`,
      );
    }
  }
  return lines.join("\n");
}
