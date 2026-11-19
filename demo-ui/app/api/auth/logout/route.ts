import { NextResponse } from "next/server";
import { rejectNonLocal } from "@/lib/server/local-only";
import { SESSION_COOKIE } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
