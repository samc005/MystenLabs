import { FaucetError, FaucetRateLimitError, getFaucetHost, requestSuiFromFaucetV3 } from "@mysten/sui/faucet";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { assertTestnet } from "../config.js";
import type { SuiNetwork } from "./client.js";

export interface FaucetReceipt {
  digest: string;
  recipient: string;
  amountMist: bigint;
}

/**
 * Asks the testnet faucet for SUI. The faucet chooses the amount.
 * Proof-of-work can take up to a few minutes. A rate limit is not retried.
 */
export async function fundFromFaucet(network: SuiNetwork, recipient: string): Promise<FaucetReceipt> {
  assertTestnet(network);
  try {
    const result = await requestSuiFromFaucetV3({
      host: getFaucetHost("testnet"),
      recipient,
      timeout: 180_000,
    });
    return {
      digest: result.digest,
      recipient: result.recipient,
      amountMist: BigInt(result.amountMist),
    };
  } catch (error) {
    if (error instanceof FaucetRateLimitError) {
      throw new Error(
        "The testnet faucet rate-limited this request. Wait a few minutes, or request SUI at https://faucet.sui.io.",
      );
    }
    if (error instanceof FaucetError) {
      const digest = error.digest ? ` Check digest ${error.digest} before requesting again.` : "";
      throw new Error(`Faucet request failed (${error.status}): ${error.message}.${digest}`);
    }
    throw error;
  }
}

/** Waits until the faucet transaction is checkpointed so a balance read sees the funds. */
export async function waitForFaucet(client: SuiGrpcClient, digest: string): Promise<void> {
  const result = await client.waitForTransaction({ digest, timeout: 60_000 });
  if (result.$kind === "FailedTransaction") {
    const message = result.FailedTransaction.status.error?.message ?? "Faucet transaction failed.";
    throw new Error(message);
  }
}
