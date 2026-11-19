import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

/** Upper bound on agent keys one signer will mint, so provisioning cannot fill the disk. */
export const defaultMaxAgentKeys = 1000;

const KEY_FILE = /^(0x[0-9a-f]{64})\.json$/;

export interface Keyring {
  /** The agent key for this address, if the signer minted it. */
  get(address: string): Ed25519Keypair | undefined;
  /** Mint and persist a new agent key. Returns its address; the secret never leaves the signer. */
  create(): Promise<string>;
  size(): number;
}

/**
 * Per-account agent keys, one private file each. Only the signer process reads this
 * directory: the UI and the MCP server only ever see the public address.
 */
export async function openKeyring(dir: string, options: { max?: number } = {}): Promise<Keyring> {
  const max = options.max ?? defaultMaxAgentKeys;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await stat(dir);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077) {
    throw new Error("The signer keyring must be a private directory owned by the signer user.");
  }

  const keys = new Map<string, Ed25519Keypair>();
  for (const name of await readdir(dir)) {
    const match = KEY_FILE.exec(name);
    if (!match) continue;
    const stored = JSON.parse(await readFile(join(dir, name), "utf8")) as { secretKey?: unknown };
    if (typeof stored.secretKey !== "string") throw new Error(`Invalid keyring entry ${name}.`);
    const keypair = Ed25519Keypair.fromSecretKey(stored.secretKey);
    if (keypair.toSuiAddress() !== match[1]) throw new Error(`Keyring entry ${name} does not match its address.`);
    keys.set(match[1], keypair);
  }

  // One creation at a time, so the cap holds and two requests cannot race on a file.
  let queue: Promise<unknown> = Promise.resolve();

  async function createOne(): Promise<string> {
    if (keys.size >= max) throw new Error("keyring_full");
    const keypair = Ed25519Keypair.generate();
    const address = keypair.toSuiAddress();
    const temporary = join(dir, `${address}.${randomUUID()}.tmp`);
    await writeFile(
      temporary,
      JSON.stringify({ network: "testnet", address, secretKey: keypair.getSecretKey() }),
      { mode: 0o600, flag: "wx" },
    );
    await rename(temporary, join(dir, `${address}.json`));
    keys.set(address, keypair);
    return address;
  }

  return {
    get: (address) => keys.get(address),
    create() {
      const result = queue.then(createOne);
      queue = result.catch(() => undefined);
      return result;
    },
    size: () => keys.size,
  };
}
