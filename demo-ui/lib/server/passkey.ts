import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
};

type Challenge = {
  value: string;
  kind: "registration" | "authentication";
  enrollmentAuthorized?: boolean;
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

async function loadStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = readFile(STORE_FILE, "utf8")
      .then((raw) => {
        const parsed = JSON.parse(raw) as Partial<Store>;
        if (!Array.isArray(parsed.credentials) || typeof parsed.revoked !== "boolean") {
          throw new Error("Invalid credential store.");
        }
        return {
          credentials: Array.isArray(parsed.credentials) ? parsed.credentials : [],
          revoked: parsed.revoked === true,
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
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(STORE_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
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

export async function passkeyStatus(): Promise<{ registered: boolean; credentialCount: number; revoked: boolean }> {
  const store = await loadStore();
  return { registered: store.credentials.length > 0, credentialCount: store.credentials.length, revoked: store.revoked };
}

export async function registrationOptions(request: Request, approvalId?: string) {
  const { rpID } = requestContext(request);
  const store = await loadStore();
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
    enrollmentAuthorized,
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

  const store = await loadStore();
  if (store.credentials.length > 0 && !challenge.enrollmentAuthorized) {
    throw new Error("An existing passkey must approve adding a device.");
  }
  const credential = result.registrationInfo.credential;
  if (!store.credentials.some((entry) => entry.id === credential.id)) {
    store.credentials.push({
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64"),
      counter: credential.counter,
      transports: response.response.transports,
      label: `Device ${store.credentials.length + 1}`,
      createdAt: new Date().toISOString(),
    });
    await saveStore(store);
  }
}

export async function authenticationOptions(request: Request, proposalHash: string) {
  if (!/^[a-f0-9]{64}$/.test(proposalHash)) throw new Error("Invalid proposal hash.");
  const { rpID } = requestContext(request);
  const store = await loadStore();
  if (store.credentials.length === 0) throw new Error("Register a passkey before approving an action.");
  const challengeId = randomUUID();
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
  credential.counter = result.authenticationInfo.newCounter;
  await saveStore(store);

  const approvalId = randomUUID();
  approvals.set(approvalId, {
    id: approvalId,
    proposalHash: challenge.proposalHash!,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
    used: false,
  });
  return { approvalId, proposalHash: challenge.proposalHash! };
}

export async function consumeApproval(approvalId: string, proposalHash: string): Promise<void> {
  const approval = approvals.get(approvalId);
  if (!approval || approval.used || approval.expiresAt < Date.now() || approval.proposalHash !== proposalHash) {
    throw new Error("Passkey approval is missing, expired, already used, or bound to different action data.");
  }
  approval.used = true;
}

export async function setRevoked(revoked: boolean): Promise<void> {
  const store = await loadStore();
  store.revoked = revoked;
  await saveStore(store);
}
