// Usage: npm run balance -- [address] [--network testnet|mainnet|devnet|localnet]
// Address falls back to $SUI_ADDRESS, then to the Sui CLI's active address.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import { createSuiClient, isSuiNetwork, type SuiNetwork } from "../sui/client.js";
import { getAllBalances } from "../sui/balances.js";

function parseArgs(argv: string[]): { address?: string; network: SuiNetwork } {
  let address: string | undefined;
  let network: SuiNetwork = "testnet";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--network") {
      const value = argv[++i] ?? "";
      if (!isSuiNetwork(value)) throw new Error(`Unknown network: "${value}"`);
      network = value;
    } else {
      address = arg;
    }
  }
  return { address, network };
}

async function readCliActiveAddress(): Promise<string | undefined> {
  try {
    const config = await readFile(join(homedir(), ".sui", "sui_config", "client.yaml"), "utf8");
    return config.match(/^active_address:\s*"?(0x[0-9a-fA-F]+)"?/m)?.[1];
  } catch {
    return undefined;
  }
}

async function main() {
  const { address: argAddress, network } = parseArgs(process.argv.slice(2));
  const address = argAddress ?? process.env.SUI_ADDRESS ?? (await readCliActiveAddress());
  if (!address) {
    throw new Error("No address given. Pass one as an argument or set SUI_ADDRESS.");
  }
  if (!isValidSuiAddress(normalizeSuiAddress(address))) {
    throw new Error(`Not a valid Sui address: ${address}`);
  }
  const owner = normalizeSuiAddress(address);

  const client = createSuiClient(network);
  const balances = await getAllBalances(client, owner);

  console.log(`Address: ${owner}`);
  console.log(`Network: ${network}`);
  if (balances.length === 0) {
    console.log("No coins found.");
    return;
  }
  for (const b of balances) {
    console.log(`  ${b.formatted.padStart(20)} ${b.symbol}  (${b.coinType})`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
