import { NextResponse } from "next/server";
import { createZkLoginNonce, enokiConfigured } from "@/lib/server/enoki";
import { authorizationUrl, googleConfig, pkceChallenge, randomToken } from "@/lib/server/google-oauth";
import { rejectNonLocal } from "@/lib/server/local-only";
import { cookieOptions, OAUTH_COOKIE, OAUTH_TTL_MS, seal } from "@/lib/server/session";
import { isEphemeralPublicKey } from "@/lib/server/zklogin-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sign-in without a wallet: stores state, nonce and PKCE verifier in a signed cookie, then redirects. */
export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const config = googleConfig();
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken(48);
    const response = NextResponse.redirect(
      authorizationUrl(config, { state, nonce, codeChallenge: pkceChallenge(verifier) }),
    );
    response.cookies.set(OAUTH_COOKIE, seal({ state, nonce, verifier }, OAUTH_TTL_MS), cookieOptions(OAUTH_TTL_MS));
    return response;
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Sign-in is not configured." }, { status: 500 });
  }
}

/**
 * Sign-in that also opens a zkLogin wallet session. The browser sends only its ephemeral PUBLIC key;
 * the Google nonce commits to it, so the resulting proof works only with that browser's private key.
 * Returns the Google URL for the browser to navigate to.
 */
export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  const body = (await request.json().catch(() => ({}))) as { ephemeralPublicKey?: unknown };
  try {
    const config = googleConfig();
    const state = randomToken();
    const verifier = randomToken(48);
    let nonce = randomToken();
    let zk: { publicKey: string; randomness: string; maxEpoch: number; expiresAt: number } | undefined;
    if (enokiConfigured() && isEphemeralPublicKey(body.ephemeralPublicKey)) {
      const created = await createZkLoginNonce(body.ephemeralPublicKey);
      nonce = created.nonce;
      zk = {
        publicKey: body.ephemeralPublicKey,
        randomness: created.randomness,
        maxEpoch: created.maxEpoch,
        expiresAt: created.estimatedExpiration,
      };
    }
    const response = NextResponse.json({
      url: authorizationUrl(config, { state, nonce, codeChallenge: pkceChallenge(verifier) }),
      zkLogin: Boolean(zk),
    });
    response.cookies.set(OAUTH_COOKIE, seal({ state, nonce, verifier, zk }, OAUTH_TTL_MS), cookieOptions(OAUTH_TTL_MS));
    return response;
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Sign-in is not configured." }, { status: 500 });
  }
}
