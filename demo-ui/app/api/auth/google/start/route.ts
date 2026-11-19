import { NextResponse } from "next/server";
import { authorizationUrl, googleConfig, pkceChallenge, randomToken } from "@/lib/server/google-oauth";
import { rejectNonLocal } from "@/lib/server/local-only";
import { cookieOptions, OAUTH_COOKIE, OAUTH_TTL_MS, seal } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts sign-in: stores state, nonce and PKCE verifier in a signed cookie, then sends the user to Google. */
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
