import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createSuiClient } from "../blockchain/client.js";
import { requireWallet } from "../blockchain/wallet.js";
import { assertTestnet, resolveNetwork } from "../config.js";
import { signerHost, signerPort, signerTimeoutMs, signerToken } from "./protocol.js";
import { createSignerServer } from "./server.js";

async function main() {
  assertTestnet(resolveNetwork());
  const stateDir = process.env.SUI_SIGNER_STATE_DIR;
  if (!stateDir || !isAbsolute(stateDir)) {
    throw new Error("Set SUI_SIGNER_STATE_DIR to an absolute private directory.");
  }
  const token = signerToken.safeParse(process.env.SUI_SIGNER_TOKEN);
  if (!token.success) throw new Error("Set SUI_SIGNER_TOKEN to 32 random bytes encoded in lowercase hex.");
  if (!process.env.SUI_WALLET_FILE && !process.env.SUI_SECRET_KEY) {
    throw new Error("Configure a signer-owned SUI_WALLET_FILE or SUI_SECRET_KEY.");
  }
  if (process.env.SUI_WALLET_FILE && !process.env.SUI_SECRET_KEY) {
    const walletFile = await stat(process.env.SUI_WALLET_FILE);
    if (!walletFile.isFile() || walletFile.uid !== process.getuid?.() || (walletFile.mode & 0o077)) {
      throw new Error("SUI_WALLET_FILE must be a private file owned by the signer user.");
    }
  }
  for (const directory of [stateDir, join(stateDir, "approvals"), join(stateDir, "consumed")]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await stat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
      throw new Error("Signer state directories must be private and owned by the signer user.");
    }
  }

  const port = signerPort();
  const client = createSuiClient("testnet");
  const { chainIdentifier } = await client.getChainIdentifier({
    signal: AbortSignal.timeout(signerTimeoutMs),
  });
  const { keypair, address } = await requireWallet("testnet").catch(() => {
    throw new Error("Could not load the configured testnet signing key.");
  });
  const server = createSignerServer({
    token: token.data,
    stateDir,
    chainIdentifier,
    keypair,
    async getCurrentEpoch(signal) {
      const { systemState } = await client.core.getCurrentSystemState({ signal });
      return BigInt(systemState.epoch);
    },
  });
  server.on("error", () => {
    console.error("Could not bind the signer listener.");
    process.exitCode = 1;
  });
  server.listen(port, signerHost, () => {
    console.error(`Testnet signer listening on ${signerHost}:${port} for ${address}`);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Signer startup failed.");
  process.exitCode = 1;
});
