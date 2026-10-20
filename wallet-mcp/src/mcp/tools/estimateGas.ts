import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createSuiClient } from "../../blockchain/client.js";
import { formatUnits } from "../../blockchain/balance.js";
import { resolveNetwork } from "../../config.js";

export function registerEstimateGas(server: McpServer): void {
  server.registerTool(
    "estimate_gas",
    {
      description:
        "Simulate a serialized Sui transaction without signing or submitting it and report estimated gas.",
      inputSchema: z.object({
        transactionBase64: z.string().min(1).describe("Base64-encoded serialized transaction bytes."),
      }),
    },
    async ({ transactionBase64 }) => {
      try {
        const network = resolveNetwork();
        let transaction: Uint8Array;
        try {
          transaction = Uint8Array.from(Buffer.from(transactionBase64, "base64"));
        } catch {
          throw new Error("transactionBase64 must be valid base64.");
        }
        if (transaction.length === 0) throw new Error("transactionBase64 must not be empty.");

        const result = await createSuiClient(network).simulateTransaction({
          transaction,
          include: { effects: true, balanceChanges: true },
        });
        const executed = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
        const gas = executed.effects?.gasUsed;
        const gasMist = gas
          ? BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate)
          : null;
        const status = executed.status.error ? `failed: ${executed.status.error}` : "success";
        return {
          content: [
            {
              type: "text",
              text: [
                `Network: ${network}`,
                `Simulation: ${status}`,
                `Estimated gas: ${gasMist === null ? "unavailable" : `${formatUnits(gasMist, 9)} SUI`}`,
                `Gas mocked: ${result.gasPaymentMocked ? "yes" : "no"}`,
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );
}
