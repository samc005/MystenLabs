// Signed cookies for sign-in. The server signs them with SESSION_SECRET, so a cookie cannot be
// forged or altered. They hold only the Google subject and email, never a key or token.

import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "cipher_session";
export const OAUTH_COOKIE = "cipher_oauth";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OAUTH_TTL_MS = 10 * 60 * 1000;

export interface SessionUser {
  /** Google's stable subject identifier. The account key. */
  sub: string;
  email: string;
  name?: string;
}

function signingKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("Set SESSION_SECRET to at least 32 random characters.");
  return Buffer.from(secret, "utf8");
}

function mac(body: string): string {
  return createHmac("sha256", signingKey()).update(body).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function seal(payload: Record<string, unknown>, ttlMs: number, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: now + ttlMs })).toString("base64url");
  return `${body}.${mac(body)}`;
}

export function unseal(token: string | undefined, now = Date.now()): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!safeEqual(signature, mac(body))) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.exp !== "number" || record.exp <= now) return null;
  return record;
}

export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/** The signed-in user for this request, or null. Every account route checks this first. */
export function userFromRequest(request: Request, now = Date.now()): SessionUser | null {
  const payload = unseal(readCookie(request, SESSION_COOKIE), now);
  if (!payload || typeof payload.sub !== "string" || payload.sub === "") return null;
  return {
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : "",
    name: typeof payload.name === "string" ? payload.name : undefined,
  };
}

export function cookieOptions(ttlMs: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(ttlMs / 1000),
    secure: process.env.NODE_ENV === "production",
  };
}
