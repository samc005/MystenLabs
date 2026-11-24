import { NextResponse } from "next/server";
import { createZkLoginProof, getZkLoginIdentity } from "@/lib/server/enoki";
import { exchangeCode, googleConfig, verifyIdToken } from "@/lib/server/google-oauth";
import { rejectNonLocal } from "@/lib/server/local-only";
import {
  cookieOptions,
  OAUTH_COOKIE,
  readCookie,
  safeEqual,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  seal,
  unseal,
} from "@/lib/server/session";
import { isEphemeralPublicKey, saveZkLoginSession } from "@/lib/server/zklogin-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PendingZkLogin {
  publicKey: string;
  randomness: string;
  maxEpoch: number;
  expiresAt: number;
}

function pendingZkLogin(value: unknown): PendingZkLogin | null {
  if (!value || typeof value !== "object") return null;
  const zk = value as Record<string, unknown>;
  if (
    !isEphemeralPublicKey(zk.publicKey) ||
    typeof zk.randomness !== "string" ||
    typeof zk.maxEpoch !== "number" ||
    typeof zk.expiresAt !== "number"
  ) {
    return null;
  }
  return { publicKey: zk.publicKey, randomness: zk.randomness, maxEpoch: zk.maxEpoch, expiresAt: zk.expiresAt };
}

/**
 * Derives the user's zkLogin address and a proof for the browser's ephemeral key. The ID token's
 * nonce was already checked against the one committed to that key, so the proof is bound to it.
 * Returns null if Enoki is unavailable: sign-in still works, only wallet signing waits.
 */
async function finishZkLogin(idToken: string, userId: string, zk: PendingZkLogin): Promise<string | null> {
  try {
    const [identity, proof] = await Promise.all([
      getZkLoginIdentity(idToken),
      createZkLoginProof({ jwt: idToken, ephemeralPublicKey: zk.publicKey, maxEpoch: zk.maxEpoch, randomness: zk.randomness }),
    ]);
    const address = identity.address.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(address)) throw new Error("Enoki returned an invalid address.");
    await saveZkLoginSession({
      userId,
      address,
      ephemeralPublicKey: zk.publicKey,
      maxEpoch: zk.maxEpoch,
      proof,
      expiresAt: zk.expiresAt,
    });
    return address;
  } catch (error) {
    console.error("[zklogin]", error instanceof Error ? error.message : error);
    return null;
  }
}

function failed(request: Request, reason: string) {
  const response = NextResponse.redirect(new URL(`/?auth=failed&reason=${reason}`, request.url));
  response.cookies.set(OAUTH_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}

/** Finishes sign-in. Any Google account with a verified email may sign in: sign-up is open. */
export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;

  const url = new URL(request.url);
  if (url.searchParams.get("error")) return failed(request, "cancelled");

  const pending = unseal(readCookie(request, OAUTH_COOKIE));
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (
    typeof pending?.state !== "string" ||
    typeof pending.nonce !== "string" ||
    typeof pending.verifier !== "string" ||
    !code ||
    !safeEqual(state, pending.state)
  ) {
    return failed(request, "invalid_state");
  }

  try {
    const config = googleConfig();
    const idToken = await exchangeCode(config, code, pending.verifier);
    const claims = await verifyIdToken(idToken, { clientId: config.clientId, nonce: pending.nonce });
    if (!claims.email || claims.email_verified !== true) return failed(request, "unverified_email");

    const zk = pendingZkLogin(pending.zk);
    const zkAddress = zk ? await finishZkLogin(idToken, claims.sub, zk) : null;

    // The home page sends them on: to Cipher if their account is ready, to setup if it is not.
    const response = NextResponse.redirect(new URL(zk && !zkAddress ? "/?zk=failed" : "/", request.url));
    response.cookies.set(
      SESSION_COOKIE,
      seal({ sub: claims.sub, email: claims.email, name: claims.name, ...(zkAddress ? { zkAddress } : {}) }, SESSION_TTL_MS),
      cookieOptions(SESSION_TTL_MS),
    );
    response.cookies.set(OAUTH_COOKIE, "", { path: "/", maxAge: 0 });
    return response;
  } catch {
    return failed(request, "exchange_failed");
  }
}
