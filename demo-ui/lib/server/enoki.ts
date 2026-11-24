// zkLogin through Mysten's Enoki API. Enoki keeps each user's salt and generates the zero-knowledge
// proofs, so this app never stores a secret that could recreate a user's wallet.
//
// Trust boundary: the server sees the user's Google ID token and the proof, but never the
// ephemeral private key, which is generated and kept in the user's browser. A proof without that
// key cannot sign, so the server still cannot move a user's funds.
//
// Called over HTTP (not @mysten/enoki) because that SDK needs a newer @mysten/sui major version.

const ENOKI_API = "https://api.enoki.mystenlabs.com/v1";
const NETWORK = "testnet";
/** How many epochs (about a day each on testnet) a sign-in can sign for. Enoki's default. */
const ADDITIONAL_EPOCHS = 2;

export interface ZkLoginNonce {
  nonce: string;
  randomness: string;
  maxEpoch: number;
  estimatedExpiration: number;
}

export interface ZkLoginIdentity {
  address: string;
  salt: string;
}

/** The zkLogin proof inputs, without the user signature (the browser adds that when it signs). */
export type ZkLoginProof = {
  proofPoints: { a: string[]; b: string[][]; c: string[] };
  issBase64Details: { value: string; indexMod4: number };
  headerBase64: string;
  addressSeed: string;
};

export function enokiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ENOKI_API_KEY);
}

async function enoki<T>(path: string, init: { method: "GET" | "POST"; jwt?: string; body?: unknown }): Promise<T> {
  const apiKey = process.env.ENOKI_API_KEY;
  if (!apiKey) throw new Error("Set ENOKI_API_KEY to enable zkLogin wallets.");
  const response = await fetch(`${ENOKI_API}/${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(init.jwt ? { "zklogin-jwt": init.jwt } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = "";
    try {
      detail = (JSON.parse(text) as { errors?: { message?: string }[] }).errors?.[0]?.message ?? "";
    } catch {
      // Not JSON. The status code is enough.
    }
    throw new Error(`Enoki ${path} failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return (JSON.parse(text) as { data: T }).data;
}

/** A nonce that commits to the browser's ephemeral public key. Google signs it into the ID token. */
export function createZkLoginNonce(ephemeralPublicKey: string): Promise<ZkLoginNonce> {
  return enoki<ZkLoginNonce>("zklogin/nonce", {
    method: "POST",
    body: { network: NETWORK, ephemeralPublicKey, additionalEpochs: ADDITIONAL_EPOCHS },
  });
}

/** The user's zkLogin address for this app's Google client. Same Google account, same address. */
export function getZkLoginIdentity(jwt: string): Promise<ZkLoginIdentity> {
  return enoki<ZkLoginIdentity>("zklogin", { method: "GET", jwt });
}

export function createZkLoginProof(input: {
  jwt: string;
  ephemeralPublicKey: string;
  maxEpoch: number;
  randomness: string;
}): Promise<ZkLoginProof> {
  return enoki<ZkLoginProof>("zklogin/zkp", {
    method: "POST",
    jwt: input.jwt,
    body: {
      network: NETWORK,
      ephemeralPublicKey: input.ephemeralPublicKey,
      maxEpoch: input.maxEpoch,
      randomness: input.randomness,
    },
  });
}
