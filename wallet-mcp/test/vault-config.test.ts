import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_VAULT, hasExplicitVaultConfig, vaultConfig } from "../src/config.js";

test("vaultConfig uses defaults when no vault env is set", () => {
  const env = {};
  assert.equal(hasExplicitVaultConfig(env), false);
  assert.deepEqual(vaultConfig(env), DEFAULT_VAULT);
});

test("vaultConfig accepts a complete explicit override", () => {
  const env = {
    SUI_VAULT_PACKAGE_ID: "0xpkg",
    SUI_VAULT_ID: "0xvault",
    SUI_VAULT_AGENT_CAP_ID: "0xcap",
  };
  assert.equal(hasExplicitVaultConfig(env), true);
  assert.deepEqual(vaultConfig(env), {
    packageId: "0xpkg",
    vaultId: "0xvault",
    agentCapId: "0xcap",
  });
});

test("vaultConfig rejects partial overrides", () => {
  assert.throws(
    () => vaultConfig({ SUI_VAULT_ID: "0xvault" }),
    /Incomplete vault overrides/,
  );
  assert.throws(
    () =>
      vaultConfig({
        SUI_VAULT_PACKAGE_ID: "0xpkg",
        SUI_VAULT_ID: "0xvault",
      }),
    /SUI_VAULT_AGENT_CAP_ID/,
  );
});
