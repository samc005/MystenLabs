import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import { formatBalanceReport, getAllBalances } from "../blockchain/balance.js";
import { createSuiClient, isSuiNetwork, type SuiNetwork } from "../blockchain/client.js";
import { loadWallet } from "../blockchain/wallet.js";
import { resolveNetwork } from "../config.js";

function parseArgs(argv: string[]): { address?: string; network: SuiNetwork } {
  let address: string | undefined;
  let network = resolveNetwork();
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
  const localWallet = network === "testnet" ? await loadWallet(network) : undefined;
  const address = argAddress ?? process.env.SUI_ADDRESS ?? localWallet?.address ?? (await readCliActiveAddress());
  if (!address) {
    throw new Error("No address given. Pass one, set SUI_ADDRESS, or run npm run setup.");
  }
  if (!isValidSuiAddress(normalizeSuiAddress(address))) {
    throw new Error(`Not a valid Sui address: ${address}`);
  }
  const owner = normalizeSuiAddress(address);
  const balances = await getAllBalances(createSuiClient(network), owner);
  console.log(formatBalanceReport(network, owner, balances));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
