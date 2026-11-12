import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_DECIMALS } from "@mysten/sui/utils";
import { assertTestnet, explorerTxUrl, vaultConfig } from "../config.js";
import { formatUnits } from "./balance.js";
import type { SuiNetwork } from "./client.js";
import {
  createSpendProposal,
  describeProposal,
  isSpendProposal,
  requireProposal,
  updateProposal,
  type Proposal,
  type SpendProposal,
} from "./proposals.js";
import { netGasMist } from "./transfer.js";
import { classifySpend, getVaultStatus } from "./vault.js";
import { requireAddress } from "./address.js";

const sui = (mist: bigint) => `${formatUnits(mist, SUI_DECIMALS)} SUI`;

/** Net gas can be negative here: deleting the owner's approval refunds its storage. */
const gasLine = (gasMist: bigint) =>
  gasMist < 0n
    ? `Gas: nothing net (the storage refund from the used approval covered it)`
    : `Gas (paid by the agent wallet): ${sui(gasMist)}`;

/**
 * Records a request to pay something the spending policy does not allow directly (over the
 * per-spend limit or the epoch cap, or to a recipient the owner has not allowed). Nothing
 * moves: the owner approves it, which signs a single-use on-chain approval for exactly
 * this recipient and amount, and only then can the agent run it.
 */
export async function proposeSpend(input: {
  client: SuiGrpcClient;
  network: SuiNetwork;
  recipient: string;
  amountMist: bigint;
}): Promise<SpendProposal> {
  assertTestnet(input.network);
  if (input.amountMist <= 0n) throw new Error("Amount must be greater than 0.");
  const recipient = requireAddress(input.recipient);
  const status = await getVaultStatus(input.client, vaultConfig());
  if (status.paused) throw new Error("The vault is paused by its owner. No spends are allowed.");
  if (input.amountMist > status.balanceMist) {
    throw new Error(`The vault only holds ${sui(status.balanceMist)}, less than the requested ${sui(input.amountMist)}.`);
  }
  const verdict = classifySpend(status, recipient, input.amountMist);
  if (verdict.direct) {
    throw new Error(
      `This payment is already within the spending policy, so no approval is needed. Use vault_spend to pay ${recipient} directly.`,
    );
  }
  return createSpendProposal({
    recipient,
    amountMist: input.amountMist.toString(),
    reason: verdict.reason,
  });
}

/** Prepare an owner-approved payment without loading any private key. */
export async function prepareSpendProposal(input: {
  client: SuiGrpcClient; network: SuiNetwork; sender: string; proposalId: string;
}) {
  assertTestnet(input.network);
  const proposal = await requireProposal(input.proposalId);
  if (!isSpendProposal(proposal)) {
    throw new Error(`Proposal ${proposal.id} is a swap, not a payment. Run it with vault_swap.`);
  }
  if (proposal.status === "executed") {
    throw new Error("Proposal already executed.");
  }
  if (proposal.status !== "approved" || !proposal.intentId) {
    throw new Error(
      `Proposal ${proposal.id} is ${proposal.status}, not approved. ` +
        (proposal.status === "pending"
          ? "The owner has not approved it yet. Do not retry; wait for them to approve it in the UI."
          : "It cannot be executed."),
    );
  }

  const config = vaultConfig();
  const sender = requireAddress(input.sender);
  const status = await getVaultStatus(input.client, config);
  if (status.paused) throw new Error("The vault is paused by its owner. No spends are allowed.");
  const intent = status.spendIntents.find((i) => i.intentId === proposal.intentId);
  if (!intent) {
    throw new Error(
      `No open approval ${proposal.intentId}. It was already used, cancelled, or never created.`,
    );
  }
  if (Date.now() > intent.expiryMs) {
    throw new Error(`The approval for ${proposal.id} expired at ${new Date(intent.expiryMs).toISOString()}.`);
  }
  if (intent.amountMist > status.balanceMist) {
    throw new Error(`The vault only holds ${sui(status.balanceMist)}, less than the approved ${sui(intent.amountMist)}.`);
  }

  const tx = new Transaction();
  tx.setSender(sender);
  tx.moveCall({
    target: `${config.packageId}::spending_vault::spend_approved`,
    arguments: [
      tx.object(config.agentCapId),
      tx.object(config.vaultId),
      tx.pure.id(intent.intentId),
      tx.object.clock(),
    ],
  });

  return { tx, proposal, intent };
}

/** Runs the payment the owner approved for a spend proposal. The agent wallet only pays gas. */
export async function executeSpendProposal(input: {
  client: SuiGrpcClient;
  network: SuiNetwork;
  signer: Ed25519Keypair;
  proposalId: string;
  dryRun?: boolean;
}): Promise<{ proposal: Proposal; text: string }> {
  assertTestnet(input.network);
  const proposal = await requireProposal(input.proposalId);
  if (!isSpendProposal(proposal)) {
    throw new Error(`Proposal ${proposal.id} is a swap, not a payment. Run it with vault_swap.`);
  }
  if (proposal.status === "executed") {
    return { proposal, text: `Already paid.\n${describeProposal(proposal)}` };
  }
  if (proposal.status !== "approved" || !proposal.intentId) {
    throw new Error(
      `Proposal ${proposal.id} is ${proposal.status}, not approved. ` +
        (proposal.status === "pending"
          ? "The owner has not approved it yet. Do not retry; wait for them to approve it in the UI."
          : "It cannot be executed."),
    );
  }

  const config = vaultConfig();
  const sender = input.signer.toSuiAddress();
  const status = await getVaultStatus(input.client, config);
  if (status.paused) throw new Error("The vault is paused by its owner. No spends are allowed.");
  const intent = status.spendIntents.find((i) => i.intentId === proposal.intentId);
  if (!intent) {
    throw new Error(
      `No open approval ${proposal.intentId}. It was already used, cancelled, or never created.`,
    );
  }
  if (Date.now() > intent.expiryMs) {
    throw new Error(`The approval for ${proposal.id} expired at ${new Date(intent.expiryMs).toISOString()}.`);
  }
  if (intent.amountMist > status.balanceMist) {
    throw new Error(`The vault only holds ${sui(status.balanceMist)}, less than the approved ${sui(intent.amountMist)}.`);
  }

  const tx = new Transaction();
  tx.setSender(sender);
  tx.moveCall({
    target: `${config.packageId}::spending_vault::spend_approved`,
    arguments: [
      tx.object(config.agentCapId),
      tx.object(config.vaultId),
      tx.pure.id(intent.intentId),
      tx.object.clock(),
    ],
  });

  if (input.dryRun) {
    const result = await input.client.simulateTransaction({ transaction: tx, include: { effects: true } });
    const outcome = result.$kind === "FailedTransaction" ? result.FailedTransaction : result.Transaction;
    const gas = outcome.effects?.gasUsed ?? null;
    const lines = [
      `DRY RUN (nothing was signed or submitted)`,
      `Status: ${
        result.$kind === "Transaction" ? "would succeed" : `would FAIL: ${outcome.status.error?.message ?? "Simulation failed."}`
      }`,
      `Agent wallet: ${sender}`,
      `Pays ${sui(intent.amountMist)} to ${intent.recipient} under the owner's approval`,
    ];
    if (gas) lines.push(gasLine(netGasMist(gas)));
    return { proposal, text: lines.join("\n") };
  }

  try {
    const submitted = await input.client.signAndExecuteTransaction({
      transaction: tx,
      signer: input.signer,
      include: { effects: true },
    });
    if (submitted.$kind === "FailedTransaction") {
      throw new Error(submitted.FailedTransaction.status.error?.message ?? "Transaction failed.");
    }
    const settled = await input.client.waitForTransaction({
      result: submitted,
      include: { effects: true },
      timeout: 60_000,
    });
    if (settled.$kind === "FailedTransaction") {
      throw new Error(settled.FailedTransaction.status.error?.message ?? "Transaction failed.");
    }
    const executed = settled.Transaction;
    const gas = executed.effects?.gasUsed;
    const updated = await updateProposal(proposal.id, { status: "executed", spendDigest: executed.digest });
    const lines = [
      `Paid ${sui(intent.amountMist)} from the spending vault, under the owner's approval`,
      `To: ${intent.recipient}`,
      `Signed by agent wallet: ${sender}`,
      `Digest: ${executed.digest}`,
      `Explorer: ${explorerTxUrl(input.network, executed.digest)}`,
    ];
    if (gas) lines.push(gasLine(netGasMist(gas)));
    return { proposal: updated, text: lines.join("\n") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateProposal(proposal.id, { error: message });
    throw error;
  }
}
