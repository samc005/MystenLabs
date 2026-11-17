import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";

const RP_NAME = "Sui AI Wallet";
const STORE_DIR = path.join(process.cwd(), ".passkey");
const STORE_FILE = path.join(STORE_DIR, "credentials.json");
const CHALLENGE_TTL_MS = 2 * 60_000;

type StoredCredential = {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  label: string;
  createdAt: string;
};

type Store = {
  credentials: StoredCredential[];
  revoked: boolean;
  enrollmentTokenHash?: string;
};

type Challenge = {
  value: string;
  kind: "registration" | "authentication";
  enrollmentAuthorized?: boolean;
  revision: number;
  recoveryEnrollmentAuthorized?: boolean;
  proposalHash?: string;
  expiresAt: number;
};

type Approval = {
  id: string;
  proposalHash: string;
  expiresAt: number;
  used: boolean;
};

const challenges = new Map<string, Challenge>();
const approvals = new Map<string, Approval>();
let storePromise: Promise<Store> | undefined;
let credentialRevision = 0;
let mutations: Promise<unknown> = Promise.resolve();
function mutate<T>(work: () => Promise<T>): Promise<T> {
  const result = mutations.then(work);
  mutations = result.catch(() => undefined);
  return result;
}
function invalidateAuthorizations() {
  credentialRevision++;
  challenges.clear();
  approvals.clear();
}

async function loadStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = readFile(STORE_FILE, "utf8")
      .then((raw) => {
        const parsed = JSON.parse(raw) as Partial<Store>;
        if (!Array.isArray(parsed.credentials) || typeof parsed.revoked !== "boolean") {
          throw new Error("Invalid credential store.");
        }
        if (parsed.enrollmentTokenHash !== undefined &&
            (typeof parsed.enrollmentTokenHash !== "string" || !/^[a-f0-9]{64}$/.test(parsed.enrollmentTokenHash))) {
          throw new Error("Invalid recovery enrollment state.");
        }
        return {
          credentials: Array.isArray(parsed.credentials) ? parsed.credentials : [],
          revoked: parsed.revoked === true,
          ...(typeof parsed.enrollmentTokenHash === "string" ? { enrollmentTokenHash: parsed.enrollmentTokenHash } : {}),
        };
      })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return { credentials: [], revoked: false };
        storePromise = undefined;
        throw new Error("Cannot read passkey credentials. Restore the credential store before continuing.");
      });
  }
  return storePromise;
}

async function saveStore(store: Store): Promise<void> {
  await mkdir(STORE_DIR, { recursive: true, mode: 0o700 });
  const temporary = STORE_FILE + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(store, null, 2), { mode: 0o600, flag: "wx" });
  await rename(temporary, STORE_FILE);
  storePromise = Promise.resolve(store);
}

function requestContext(request: Request): { rpID: string; origin: string } {
  const host = request.headers.get("host");
  if (!host) throw new Error("Missing host header.");
  const url = new URL(`http://${host}`);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Passkeys are available only on localhost.");
  }
  return { rpID: url.hostname.replace(/^\[|\]$/g, ""), origin: `http://${host}` };
}

function newChallenge(): string {
  return randomBytes(32).toString("base64url");
}

function rememberChallenge(id: string, challenge: Challenge): void {
  challenges.set(id, challenge);
  setTimeout(() => challenges.delete(id), CHALLENGE_TTL_MS).unref();
}

function takeChallenge(id: string, kind: Challenge["kind"]): Challenge {
  const challenge = challenges.get(id);
  challenges.delete(id);
  if (!challenge || challenge.kind !== kind || challenge.expiresAt < Date.now()) {
    throw new Error("Passkey challenge is missing or expired. Try again.");
  }
  return challenge;
}

function credentialForVerification(credential: StoredCredential): WebAuthnCredential {
  return {
    id: credential.id,
    publicKey: Uint8Array.from(Buffer.from(credential.publicKey, "base64")),
    counter: credential.counter,
    transports: credential.transports as WebAuthnCredential["transports"],
  };
}

export async function passkeyStatus(): Promise<{ registered: boolean; credentialCount: number; revoked: boolean; recoveryPending: boolean }> {
  const store = await loadStore();
  return { registered: store.credentials.length > 0, credentialCount: store.credentials.length, revoked: store.revoked, recoveryPending: Boolean(store.enrollmentTokenHash) };
}

export async function registrationOptions(request: Request, approvalId?: string, recoveryToken?: string) {
  const { rpID } = requestContext(request);
  const store = await loadStore();
  let recoveryEnrollmentAuthorized = false;
  if (store.enrollmentTokenHash) {
    if (!recoveryToken || !/^[a-f0-9]{64}$/.test(recoveryToken) ||
        createHash("sha256").update(recoveryToken).digest("hex") !== store.enrollmentTokenHash) {
      throw new Error("Complete registration in the recovery tab, or generate a new local recovery code.");
    }
    recoveryEnrollmentAuthorized = true;
  }
  const revision = credentialRevision;
  const enrollmentAuthorized = store.credentials.length > 0;
  if (enrollmentAuthorized) {
    if (!approvalId) throw new Error("An existing passkey must approve adding a device.");
    const hash = createHash("sha256").update(JSON.stringify({ action: "register-passkey", network: "testnet" })).digest("hex");
    await consumeApproval(approvalId, hash);
  }
  const challengeId = randomUUID();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: "wallet-owner",
    userDisplayName: "Wallet owner",
    attestationType: "none",
    userID: Uint8Array.from(Buffer.from("wallet-owner")),
    excludeCredentials: store.credentials.map((credential) => ({ id: credential.id })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  rememberChallenge(challengeId, {
    value: options.challenge,
    kind: "registration",
    revision,
    enrollmentAuthorized,
    recoveryEnrollmentAuthorized,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
  return { challengeId, options };
}

export async function verifyRegistration(
  request: Request,
  challengeId: string,
  response: RegistrationResponseJSON,
): Promise<void> {
  const { rpID, origin } = requestContext(request);
  const challenge = takeChallenge(challengeId, "registration");
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge.value,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!result.verified) throw new Error("Passkey registration could not be verified.");

  await mutate(async () => {
    const store = await loadStore();
    if (challenge.revision !== credentialRevision) throw new Error("Credentials changed. Start registration again.");
    if (store.credentials.length > 0 && !challenge.enrollmentAuthorized) {
      throw new Error("An existing passkey must approve adding a device.");
    }
    if (store.enrollmentTokenHash && !challenge.recoveryEnrollmentAuthorized) throw new Error("Recovery authorization required.");
    const { enrollmentTokenHash: _recovery, ...registeredStore } = store;
    const credential = result.registrationInfo.credential;
    if (!store.credentials.some(entry => entry.id === credential.id)) {
      await saveStore({
        ...registeredStore,
        credentials: [...store.credentials, {
          id: credential.id, publicKey: Buffer.from(credential.publicKey).toString("base64"),
          counter: credential.counter, transports: response.response.transports,
          label: `Device ${store.credentials.length + 1}`, createdAt: new Date().toISOString(),
        }],
      });
      invalidateAuthorizations();
    }
  });
}

export async function authenticationOptions(request: Request, proposalHash: string) {
  if (!/^[a-f0-9]{64}$/.test(proposalHash)) throw new Error("Invalid proposal hash.");
  const { rpID } = requestContext(request);
  const store = await loadStore();
  if (store.credentials.length === 0) throw new Error("Register a passkey before approving an action.");
  const challengeId = randomUUID();
  const revision = credentialRevision;
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: store.credentials.map((credential) => ({
      id: credential.id,
      transports: credential.transports as ("ble" | "cable" | "hybrid" | "internal" | "nfc" | "usb")[],
    })),
    userVerification: "required",
  });
  rememberChallenge(challengeId, {
    value: options.challenge,
    kind: "authentication",
    revision,
    proposalHash,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
  return { challengeId, options };
}

export async function verifyAuthentication(
  request: Request,
  challengeId: string,
  response: AuthenticationResponseJSON,
): Promise<{ approvalId: string; proposalHash: string }> {
  const { rpID, origin } = requestContext(request);
  const challenge = takeChallenge(challengeId, "authentication");
  const store = await loadStore();
  const credential = store.credentials.find((entry) => entry.id === response.id);
  if (!credential) throw new Error("This passkey is not registered.");
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.value,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: credentialForVerification(credential),
    requireUserVerification: true,
  });
  if (!result.verified) throw new Error("Passkey approval could not be verified.");
  return mutate(async () => {
    const current = await loadStore();
    const active = current.credentials.find(entry => entry.id === response.id);
    if (challenge.revision !== credentialRevision || !active) throw new Error("Credentials changed. Authenticate again.");
    const counter = result.authenticationInfo.newCounter;
    if (active.counter > 0 && counter <= active.counter) throw new Error("Passkey counter did not advance.");
    await saveStore({ ...current, credentials: current.credentials.map(entry =>
      entry.id === active.id ? { ...entry, counter } : entry) });
    const approvalId = randomUUID();
    approvals.set(approvalId, {
      id: approvalId, proposalHash: challenge.proposalHash!,
      expiresAt: Date.now() + CHALLENGE_TTL_MS, used: false,
    });
    return { approvalId, proposalHash: challenge.proposalHash! };
  });
}

export async function consumeApproval(approvalId: string, proposalHash: string): Promise<void> {
  const approval = approvals.get(approvalId);
  if (!approval || approval.used || approval.expiresAt < Date.now() || approval.proposalHash !== proposalHash) {
    throw new Error("Passkey approval is missing, expired, already used, or bound to different action data.");
  }
  approval.used = true;
}

export async function setRevoked(revoked: boolean): Promise<void> {
  await mutate(async () => {
    const store = await loadStore();
    await saveStore({ ...store, revoked });
  });
}

export async function listCredentials(approvalId: string) {
  const hash = createHash("sha256").update(JSON.stringify({ action: "list-passkeys" })).digest("hex");
  await consumeApproval(approvalId, hash);
  return (await loadStore()).credentials.map(({ id, label, createdAt }) => ({ id, label, createdAt }));
}

export async function removeCredential(id: string, approvalId: string): Promise<void> {
  await mutate(async () => {
    const store = await loadStore();
    if (!store.credentials.some(entry => entry.id === id)) throw new Error("Credential not found.");
    if (store.credentials.length <= 1) throw new Error("Add another passkey before removing your last one. If it is lost, use local recovery.");
    const hash = createHash("sha256").update(JSON.stringify({ action: "remove-passkey", id })).digest("hex");
    await consumeApproval(approvalId, hash);
    await saveStore({ ...store, credentials: store.credentials.filter(entry => entry.id !== id) });
    invalidateAuthorizations();
  });
}

/** Recovery requires a private, short-lived code generated by the local operator CLI. */
export async function recoverCredentials(code: string): Promise<string> {
  return mutate(async () => {
    if (!/^[a-f0-9]{64}$/.test(code)) throw new Error("Invalid or expired recovery code.");
    const recoveryFile = path.join(STORE_DIR, "recovery.json");
    let record: { hash?: string; expiresAt?: number };
    try { record = JSON.parse(await readFile(recoveryFile, "utf8")); }
    catch { throw new Error("Invalid or expired recovery code. Generate a new code in your local terminal."); }
    const actual = createHash("sha256").update(code).digest();
    if (typeof record.hash !== "string" || !/^[a-f0-9]{64}$/.test(record.hash) ||
        typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now() ||
        !timingSafeEqual(actual, Buffer.from(record.hash, "hex"))) throw new Error("Invalid or expired recovery code.");
    const store = await loadStore();
    // Atomic claim also prevents another server process from consuming the same file.
    await rename(recoveryFile, path.join(STORE_DIR, "recovery-used-" + randomUUID() + ".json"));
    await writeFile(path.join(STORE_DIR, "credentials-backup-" + randomUUID() + ".json"),
      JSON.stringify(store, null, 2), { mode: 0o600, flag: "wx" });
    const recoveryToken = randomBytes(32).toString("hex");
    await saveStore({ credentials: [], revoked: true, enrollmentTokenHash: createHash("sha256").update(recoveryToken).digest("hex") });
    invalidateAuthorizations();
    return recoveryToken;
  });
}
