import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("wallet status type includes vault readiness fields", async () => {
  // Compile-time shape is enforced in TS; this guards the exported helper contract used by UI.
  const readinessPath = path.join(root, "lib/server/vault-readiness.ts");
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(readinessPath, "utf8");
  assert.match(source, /ownerActionsReady/);
  assert.match(source, /vaultExplicit/);
  assert.match(source, /Using the shared default vault/);
});

test("proposal decision gates on owner readiness before spawning owner script", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(path.join(root, "lib/server/proposals.ts"), "utf8"),
  );
  assert.match(source, /getVaultReadiness/);
  assert.match(source, /ownerActionsReady/);
  assert.ok(source.indexOf("getVaultReadiness") < source.indexOf('spawn("npm"'));
});

test("wallet-mcp readiness modules are present after build", async () => {
  const fs = await import("node:fs/promises");
  const walletMcp = path.resolve(root, "..", "wallet-mcp");
  for (const rel of ["build/config.js", "build/blockchain/owner.js", "build/blockchain/client.js"]) {
    await fs.access(path.join(walletMcp, rel));
  }
  const walletRequire = createRequire(path.join(walletMcp, "package.json"));
  assert.match(walletRequire.resolve("./build/config.js"), /config\.js$/);
});
