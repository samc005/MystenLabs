import type { McpServer } from "@modelcontextprotocol/server";
import { parseToMist } from "@mysten/sui/utils";
import { z } from "zod";
import { createSuiClient } from "../../blockchain/client.js";
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
} from "../../blockchain/vault.js";
import { requireWallet } from "../../blockchain/wallet.js";
import { resolveNetwork } from "../../config.js";

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function registerVault(server: McpServer): void {
  server.registerTool(
    "vault_status",
    {
      description:
        "Read the spending vault: how much SUI it holds, the per-spend limit, total spent so far, whether the owner has paused it, which validators the agent may stake with, open staking positions, and the owner's policies (spending cap and recipient allowlist, stake limits, standing trade rules). Call this before vault_spend or vault_stake.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const network = resolveNetwork();
        const client = createSuiClient(network);
        const status = await getVaultStatus(client);
        return { content: [{ type: "text", text: formatVaultStatus(status) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "vault_spend",
    {
      description:
        "Pay a recipient in testnet SUI from the spending vault. The on-chain contract enforces the vault's rules: a per-spend limit, a per-epoch spending cap, an optional recipient allowlist, the vault's balance, an owner pause switch, and owner revocation. The request is rejected on-chain if any rule fails. If the payment is outside the policy, use propose_spend to ask the owner for approval instead. Amount is a decimal string in SUI, such as \"0.01\". Set dryRun to true to simulate without sending. A real spend is irreversible.",
      inputSchema: z.object({
        to: z.string().describe("Recipient Sui address (0x...)."),
        amount: z.string().describe('Amount of SUI to pay, as a decimal string such as "0.01".'),
        dryRun: z
          .boolean()
          .optional()
          .describe("If true, simulate only. Nothing is signed or submitted."),
      }),
    },
    async ({ to, amount, dryRun }) => {
      try {
        const network = resolveNetwork();
        let amountMist: bigint;
        try {
          amountMist = parseToMist(amount);
        } catch {
          throw new Error(`Amount must be a positive SUI decimal string, for example "0.01". Got "${amount}".`);
        }
        const wallet = await requireWallet(network);
        const client = createSuiClient(network);
        const input = { client, network, signer: wallet.keypair, recipient: to, amountMist };
        if (dryRun) {
          const result = await dryRunVaultSpend(input);
          return { content: [{ type: "text", text: formatVaultDryRun(result) }] };
        }
        const receipt = await vaultSpend(input);
        return { content: [{ type: "text", text: formatVaultSpendReceipt(receipt) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "vault_stake",
    {
      description:
        "Stake testnet SUI from the spending vault with a validator to earn staking rewards. The validator must be on the vault's allowlist (see vault_status); only the vault owner can add validators. Minimum 1 SUI per stake. The staking receipt stays inside the vault, so only the owner can unstake: this tool cannot withdraw a stake. The per-spend limit does not apply to staking, but the owner's stake policy (a staked-total cap, a liquid reserve, a position limit) does when one is set; see vault_status. Amount is a decimal string in SUI, such as \"1\". Set dryRun to true to simulate without sending. A real stake takes effect next epoch.",
      inputSchema: z.object({
        validator: z.string().describe("Validator Sui address (0x...). Must be on the vault's allowlist."),
        amount: z.string().describe('Amount of SUI to stake, as a decimal string such as "1".'),
        dryRun: z
          .boolean()
          .optional()
          .describe("If true, simulate only. Nothing is signed or submitted."),
      }),
    },
    async ({ validator, amount, dryRun }) => {
      try {
        const network = resolveNetwork();
        let amountMist: bigint;
        try {
          amountMist = parseToMist(amount);
        } catch {
          throw new Error(`Amount must be a positive SUI decimal string, for example "1". Got "${amount}".`);
        }
        const wallet = await requireWallet(network);
        const client = createSuiClient(network);
        const input = { client, network, signer: wallet.keypair, validator, amountMist };
        if (dryRun) {
          const result = await dryRunVaultStake(input);
          return { content: [{ type: "text", text: formatVaultStakeDryRun(result) }] };
        }
        const receipt = await vaultStake(input);
        return { content: [{ type: "text", text: formatVaultStakeReceipt(receipt) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
