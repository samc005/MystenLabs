import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isSuiNetwork, type SuiNetwork } from "./blockchain/client.js";

/** Directory that contains package.json, whether this file is run from src/ or build/. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_NETWORK: SuiNetwork = "testnet";

export function packageRoot(): string {
  return PACKAGE_ROOT;
}

/**
 * This milestone only signs on testnet. A read-only balance query may use
 * another network; anything that touches a key must call this first.
 */
export function assertTestnet(network: SuiNetwork): void {
  if (network !== "testnet") {
    throw new Error(
      `Refusing to sign on "${network}". This wallet only spends testnet SUI.`,
    );
  }
}

export function resolveNetwork(value = process.env.SUI_NETWORK): SuiNetwork {
  if (!value) return DEFAULT_NETWORK;
  if (!isSuiNetwork(value)) {
    throw new Error(`Unknown network "${value}". Use testnet, mainnet, devnet, or localnet.`);
  }
  return value;
}

export type WalletRole = "sender" | "receiver";

/** Local key file. Overridden by SUI_WALLET_FILE for the sender only. */
export function walletPath(role: WalletRole = "sender"): string {
  if (role === "sender" && process.env.SUI_WALLET_FILE) return process.env.SUI_WALLET_FILE;
  return join(PACKAGE_ROOT, ".wallet", `${role}.json`);
}

export interface VaultConfig {
  /** Package that contains the spending_vault module. */
  packageId: string;
  /** Shared Vault object that holds the money and the rules. */
  vaultId: string;
  /** AgentCap owned by the local sender wallet. Lets it call spend, nothing else. */
  agentCapId: string;
}

/**
 * Testnet deployment of my_counter::spending_vault. These are public on-chain IDs,
 * not secrets. Override with SUI_VAULT_PACKAGE_ID, SUI_VAULT_ID, SUI_VAULT_AGENT_CAP_ID.
 *
 * packageId is the latest upgrade (v3, adds owner-approved swaps; v2 added staking). Move
 * calls must target the version that has the function; the vault and caps keep their
 * original IDs across upgrades.
 */
const DEFAULT_VAULT: VaultConfig = {
  packageId: "0xfa4f3640db523d284f784cb930a9efa36fe83b4d548e91c2d0c5ebc702928bab",
  vaultId: "0xed4a0431aed6b0ff544dbfa7796fc57df573754978be85d0d4651a2f60100832",
  agentCapId: "0xcacfc4e834d9ea96aacb799843c88ebd0da5be3859744f9ac262b0828e21828d",
};

export function vaultConfig(): VaultConfig {
  return {
    packageId: process.env.SUI_VAULT_PACKAGE_ID ?? DEFAULT_VAULT.packageId,
    vaultId: process.env.SUI_VAULT_ID ?? DEFAULT_VAULT.vaultId,
    agentCapId: process.env.SUI_VAULT_AGENT_CAP_ID ?? DEFAULT_VAULT.agentCapId,
  };
}

export interface TradingConfig {
  /** Package of the testnet mock pool (testnet_pool::test_usdc). */
  poolPackageId: string;
  /** Shared Pool object that quotes SUI <-> TEST_USDC at an owner-set price. */
  poolId: string;
  /** Full type of the pool's TEST_USDC coin. */
  usdcType: string;
}

/**
 * Testnet mock DEX used to exercise vault swaps without relying on real liquidity.
 * Public on-chain IDs. Override with SUI_POOL_PACKAGE_ID, SUI_POOL_ID.
 */
const DEFAULT_TRADING = {
  poolPackageId: "0x9ce5995a4f4962e4091aa89da0197fd06b972cebc82593ca41624d37392186a4",
  poolId: "0x74f3ded415c90d624679063d7ae523278fd1b014eff74d28783f9d998e515ac9",
};

export function tradingConfig(): TradingConfig {
  const poolPackageId = process.env.SUI_POOL_PACKAGE_ID ?? DEFAULT_TRADING.poolPackageId;
  return {
    poolPackageId,
    poolId: process.env.SUI_POOL_ID ?? DEFAULT_TRADING.poolId,
    usdcType: `${poolPackageId}::test_usdc::TEST_USDC`,
  };
}

/**
 * Trade proposals made through chat live here as one JSON file each, so the MCP server
 * (a fresh process per chat turn), the UI, and the owner script all see the same state.
 */
export function proposalsDir(): string {
  return process.env.SUI_PROPOSALS_DIR ?? join(PACKAGE_ROOT, ".proposals");
}

export function explorerTxUrl(network: SuiNetwork, digest: string): string {
  return `https://suiscan.xyz/${network}/tx/${digest}`;
}

export function explorerAddressUrl(network: SuiNetwork, address: string): string {
  return `https://suiscan.xyz/${network}/account/${address}`;
}
