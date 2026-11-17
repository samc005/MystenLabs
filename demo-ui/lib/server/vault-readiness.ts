// Vault/owner readiness for the local Cipher demo. Agent actions can still run against a
// shared default vault; owner approve/fund/allowlist need a matching OwnerCap in the
// configured Sui CLI keystore. Prefer explicit SUI_VAULT_* overrides for a vault you own.

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { walletMcpDir } from "./wallet-mcp";

export interface VaultReadiness {
  /** All of SUI_VAULT_PACKAGE_ID, SUI_VAULT_ID, SUI_VAULT_AGENT_CAP_ID are set. */
  vaultExplicit: boolean;
  vaultId: string | null;
  /** Local keystore holds OwnerCap for the configured vault. */
  ownerCapReady: boolean;
  ownerAddress: string | null;
  keystorePath: string | null;
  /** Owner approve/fund/allowlist can run on this machine. */
  ownerActionsReady: boolean;
  detail: string;
}

type ProbeOwnerCap = (client: unknown, network?: string) => Promise<
  | { ok: true; address: string; ownerCapId: string; vaultId: string; keystore: string }
  | { ok: false; vaultId: string; keystore: string; detail: string }
>;

async function loadWalletMcp(): Promise<{
  hasExplicitVaultConfig: (env?: NodeJS.ProcessEnv) => boolean;
  vaultConfig: (env?: NodeJS.ProcessEnv) => { vaultId: string };
  createSuiClient: (network?: string) => unknown;
  probeOwnerCap: ProbeOwnerCap;
  keystorePath: () => string;
}> {
  const dir = walletMcpDir();
  const require = createRequire(path.join(dir, "package.json"));
  // Resolve from wallet-mcp so Next does not need to bundle those modules.
  const configUrl = pathToFileURL(require.resolve("./build/config.js")).href;
  const clientUrl = pathToFileURL(require.resolve("./build/blockchain/client.js")).href;
  const ownerUrl = pathToFileURL(require.resolve("./build/blockchain/owner.js")).href;
  const [config, client, owner] = await Promise.all([
    import(configUrl),
    import(clientUrl),
    import(ownerUrl),
  ]);
  return {
    hasExplicitVaultConfig: config.hasExplicitVaultConfig,
    vaultConfig: config.vaultConfig,
    createSuiClient: client.createSuiClient,
    probeOwnerCap: owner.probeOwnerCap,
    keystorePath: owner.keystorePath,
  };
}

export async function getVaultReadiness(): Promise<VaultReadiness> {
  try {
    const mcp = await loadWalletMcp();
    const vaultExplicit = mcp.hasExplicitVaultConfig(process.env);
    let vaultId: string | null = null;
    try {
      vaultId = mcp.vaultConfig(process.env).vaultId;
    } catch (error) {
      return {
        vaultExplicit: false,
        vaultId: null,
        ownerCapReady: false,
        ownerAddress: null,
        keystorePath: mcp.keystorePath(),
        ownerActionsReady: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (!vaultExplicit) {
      return {
        vaultExplicit: false,
        vaultId,
        ownerCapReady: false,
        ownerAddress: null,
        keystorePath: mcp.keystorePath(),
        ownerActionsReady: false,
        detail:
          "Using the shared default vault. Set SUI_VAULT_PACKAGE_ID, SUI_VAULT_ID, and SUI_VAULT_AGENT_CAP_ID in demo-ui/.env.local to a vault whose OwnerCap is in your Sui CLI keystore before approving payments.",
      };
    }
    const probe = await mcp.probeOwnerCap(mcp.createSuiClient("testnet"), "testnet");
    if (!probe.ok) {
      return {
        vaultExplicit: true,
        vaultId: probe.vaultId,
        ownerCapReady: false,
        ownerAddress: null,
        keystorePath: probe.keystore,
        ownerActionsReady: false,
        detail: probe.detail,
      };
    }
    return {
      vaultExplicit: true,
      vaultId: probe.vaultId,
      ownerCapReady: true,
      ownerAddress: probe.address,
      keystorePath: probe.keystore,
      ownerActionsReady: true,
      detail: `OwnerCap ready for vault ${probe.vaultId} via ${probe.address}.`,
    };
  } catch (error) {
    return {
      vaultExplicit: false,
      vaultId: null,
      ownerCapReady: false,
      ownerAddress: null,
      keystorePath: null,
      ownerActionsReady: false,
      detail:
        error instanceof Error
          ? `Build wallet-mcp before checking owner readiness (${error.message}).`
          : "Build wallet-mcp before checking owner readiness.",
    };
  }
}
