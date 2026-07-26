import { NextResponse } from "next/server";
import { PLATFORM_SESSION_COOKIE, platformSessionCookieOptions } from "@/lib/platform-auth";

/**
 * Clears the caller's own platform session cookie. Session-less by nature —
 * like the tenant `auth/logout`, it only unsets the cookie it was given and
 * touches nothing else, so it needs no guard.
 */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PLATFORM_SESSION_COOKIE, "", { ...platformSessionCookieOptions(), maxAge: 0 });
  return res;
}
