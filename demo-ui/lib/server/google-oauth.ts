// Google sign-in with OpenID Connect and PKCE. Written against the spec directly so the verified
// ID token is available to later steps, which need it for zkLogin.

import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  type JsonWebKeyInput,
} from "node:crypto";
import { safeEqual } from "./session";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const DEFAULT_REDIRECT_URI = "http://localhost:3000/api/auth/google/callback";
const KEY_CACHE_MS = 60 * 60 * 1000;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function googleConfig(env: NodeJS.ProcessEnv = process.env): GoogleConfig {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable Google sign-in.");
  }
  return { clientId, clientSecret, redirectUri: env.GOOGLE_REDIRECT_URI || DEFAULT_REDIRECT_URI };
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** PKCE S256 challenge for a code verifier (RFC 7636). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function authorizationUrl(
  config: GoogleConfig,
  input: { state: string; nonce: string; codeChallenge: string },
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/** Exchanges the authorization code for Google's ID token. Runs server to server, over TLS. */
export async function exchangeCode(
  config: GoogleConfig,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => ({}))) as { id_token?: unknown };
  if (!response.ok || typeof body.id_token !== "string") throw new Error("Google did not return an ID token.");
  return body.id_token;
}

type JwkKey = JsonWebKeyInput["key"] & { kid?: string };

export interface Jwks {
  keys: JwkKey[];
}

export interface IdClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

let keyCache: { fetchedAt: number; jwks: Jwks } | undefined;

async function googleKeys(fetchImpl: typeof fetch = fetch): Promise<Jwks> {
  if (keyCache && Date.now() - keyCache.fetchedAt < KEY_CACHE_MS) return keyCache.jwks;
  const response = await fetchImpl(JWKS_URL, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  const jwks = (await response.json()) as Jwks;
  if (!Array.isArray(jwks.keys)) throw new Error("Google's signing keys were not readable.");
  keyCache = { fetchedAt: Date.now(), jwks };
  return jwks;
}

function decodeSegment(segment: string): Record<string, unknown> {
  const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  if (!value || typeof value !== "object") throw new Error("Malformed ID token.");
  return value as Record<string, unknown>;
}

/**
 * Checks Google's signature and the claims that matter here: issuer, audience (our client),
 * expiry, and the nonce we sent, which ties the token to this sign-in attempt.
 */
export async function verifyIdToken(
  token: string,
  input: { clientId: string; nonce: string; jwks?: Jwks; now?: number },
): Promise<IdClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token.");
  const [headerPart, payloadPart, signaturePart] = parts;
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeSegment(headerPart);
    claims = decodeSegment(payloadPart);
  } catch {
    throw new Error("Malformed ID token.");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unsupported ID token.");

  const jwk = (input.jwks ?? (await googleKeys())).keys.find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("ID token was signed with an unknown key.");
  const valid = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${headerPart}.${payloadPart}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(signaturePart, "base64url"),
  );
  if (!valid) throw new Error("ID token signature is invalid.");

  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (typeof claims.iss !== "string" || !ISSUERS.has(claims.iss)) throw new Error("ID token issuer is wrong.");
  if (claims.aud !== input.clientId) throw new Error("ID token was issued for a different app.");
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new Error("ID token has expired.");
  if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, input.nonce)) {
    throw new Error("ID token does not match this sign-in attempt.");
  }
  if (typeof claims.sub !== "string" || claims.sub === "") throw new Error("ID token has no subject.");

  return {
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email : undefined,
    email_verified: claims.email_verified === true,
    name: typeof claims.name === "string" ? claims.name : undefined,
  };
}
