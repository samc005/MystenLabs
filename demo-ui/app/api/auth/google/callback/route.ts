import { NextResponse } from "next/server";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

    // The home page sends them on: to Cipher if their account is ready, to setup if it is not.
    const response = NextResponse.redirect(new URL("/", request.url));
    response.cookies.set(
      SESSION_COOKIE,
      seal({ sub: claims.sub, email: claims.email, name: claims.name }, SESSION_TTL_MS),
      cookieOptions(SESSION_TTL_MS),
    );
    response.cookies.set(OAUTH_COOKIE, "", { path: "/", maxAge: 0 });
    return response;
  } catch {
    return failed(request, "exchange_failed");
  }
}
