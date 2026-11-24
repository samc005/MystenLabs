// Hands a finished zkLogin proof from the sign-in callback to the browser that started sign-in.
//
// Each record is keyed by a hash of the browser's ephemeral PUBLIC key and bound to the Google
// user, so only that user, asking with that key, gets it back. The proof alone cannot sign: the
// matching ephemeral private key never leaves the browser.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accountsDir } from "./accounts";
import type { ZkLoginProof } from "./enoki";

export interface ZkLoginSession {
  userId: string;
  address: string;
  ephemeralPublicKey: string;
  maxEpoch: number;
  proof: ZkLoginProof;
  /** Milliseconds since epoch after which the proof's maxEpoch has likely passed. */
  expiresAt: number;
}

/** A Sui public key with its scheme flag, base64: 33 bytes for Ed25519. */
const EPHEMERAL_KEY = /^[A-Za-z0-9+/]{43,90}={0,2}$/;

export function isEphemeralPublicKey(value: unknown): value is string {
  return typeof value === "string" && EPHEMERAL_KEY.test(value);
}

const sessionsDir = () => join(accountsDir(), "zklogin");
const fileFor = (ephemeralPublicKey: string) =>
  join(sessionsDir(), `${createHash("sha256").update(ephemeralPublicKey).digest("hex")}.json`);

export async function saveZkLoginSession(session: ZkLoginSession): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true, mode: 0o700 });
  const temporary = join(sessionsDir(), `${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(session), { mode: 0o600, flag: "wx" });
  await rename(temporary, fileFor(session.ephemeralPublicKey));
  void pruneExpired();
}

export async function loadZkLoginSession(userId: string, ephemeralPublicKey: string): Promise<ZkLoginSession | null> {
  if (!isEphemeralPublicKey(ephemeralPublicKey)) return null;
  try {
    const session = JSON.parse(await readFile(fileFor(ephemeralPublicKey), "utf8")) as ZkLoginSession;
    if (session.userId !== userId || session.ephemeralPublicKey !== ephemeralPublicKey) return null;
    if (session.expiresAt <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

async function pruneExpired(): Promise<void> {
  try {
    for (const name of await readdir(sessionsDir())) {
      if (!name.endsWith(".json")) continue;
      const path = join(sessionsDir(), name);
      try {
        const session = JSON.parse(await readFile(path, "utf8")) as ZkLoginSession;
        if (session.expiresAt <= Date.now()) await unlink(path);
      } catch {
        // Unreadable or already removed: skip it.
      }
    }
  } catch {
    // Nothing stored yet.
  }
}
