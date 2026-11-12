import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { TransactionDataBuilder, type Transaction } from "@mysten/sui/transactions";
import { createSuiClient } from "../../blockchain/client.js";
import { writeReceipt } from "../../blockchain/writes.js";
import { assertTestnet, resolveNetwork } from "../../config.js";
import { requestSignature } from "../../signer/client.js";
import { signRequest } from "../../signer/protocol.js";

export async function unsignedTransactionResult(client: SuiGrpcClient, transaction: Transaction) {
  const [{ chainIdentifier }, { systemState }] = await Promise.all([
    client.getChainIdentifier(),
    client.core.getCurrentSystemState(),
  ]);
  const epoch = BigInt(systemState.epoch);
  transaction.setExpiration({
    ValidDuring: {
      chain: chainIdentifier,
      minEpoch: epoch.toString(),
      maxEpoch: (epoch + 1n).toString(),
      minTimestamp: null,
      maxTimestamp: null,
      nonce: randomBytes(4).readUInt32LE(),
    },
  });
  const bytes = await transaction.build({ client });
  return {
    content: [{
      type: "text" as const,
      text: "Prepared an unsigned testnet transaction. Simulate and obtain trusted policy approval for the exact transaction bytes before execution.",
    }],
    structuredContent: {
      network: "testnet",
      transactionBytes: Buffer.from(bytes).toString("base64"),
    },
  };
}

export function registerApprovedTransaction(server: McpServer): void {
  server.registerTool(
    "execute_approved_transaction",
    {
      description: "Execute the exact testnet transaction bytes in a trusted, unexpired policy-approved proposal. Chat confirmation cannot create an approval record.",
      inputSchema: signRequest,
    },
    async (input) => {
      try {
        assertTestnet(resolveNetwork());
        const signature = await requestSignature(input);
        const client = createSuiClient("testnet");
        const transaction = Buffer.from(input.transactionBytes, "base64");
        const digest = TransactionDataBuilder.getDigestFromBytes(transaction);
        const submitted = await client.executeTransaction({
          transaction,
          signatures: [signature],
          signal: AbortSignal.timeout(15_000),
        }).catch(() => {
          throw new Error(writeReceipt("testnet", digest, "Submission status unknown. Look up this digest before requesting a new approval."));
        });
        if (submitted.$kind === "FailedTransaction") {
          throw new Error(writeReceipt("testnet", digest, submitted.FailedTransaction.status.error?.message ?? "Transaction failed."));
        }
        const settled = await client.waitForTransaction({ result: submitted, timeout: 60_000 }).catch(() => null);
        if (!settled) {
          return {
            content: [{ type: "text", text: writeReceipt("testnet", digest, "Submitted. Checkpoint confirmation unavailable. Look up this digest before retrying.") }],
          };
        }
        if (settled.$kind === "FailedTransaction") {
          throw new Error(writeReceipt("testnet", digest, settled.FailedTransaction.status.error?.message ?? "Transaction failed."));
        }
        return {
          content: [{ type: "text", text: writeReceipt("testnet", digest, `Confirmed proposal ${input.proposalId}.`) }],
          structuredContent: { digest, confirmed: true },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : "Execution failed." }],
          isError: true,
        };
      }
    },
  );
}
