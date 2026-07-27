/**
 * Phase 15 — platform-admin session primitives, safe for the Edge runtime.
 *
 * The super-admin console is a *separate auth realm*: its own cookie, its own
 * signed token, and no path from a tenant session into it or back. This file
 * mirrors `auth-edge.ts` (the tenant equivalent) and, for the same reason,
 * depends only on `jose` so `src/middleware.ts` can verify a platform session
 * on Edge without dragging in the pg pool or the tenant context.
 *
 * The token is deliberately a *different cookie* under a *different name* and
 * carries a *different claim shape* (`padmin` instead of `sub`), so a platform
 * token presented to a tenant route fails `verifySession` (wrong shape) and a
 * tenant token presented to a platform route fails `verifyPlatformSession`.
 * That mutual unusability is one of the phase's exit criteria.
 */
import { SignJWT, jwtVerify } from "jose";
import { getJwtSecret } from "./jwt-secret";

/** Distinct from the tenant `pos_session` cookie — the realms never share one. */
export const PLATFORM_SESSION_COOKIE = "pos_platform_session";

/**
 * A platform admin's own role. Unlike a tenant `Role`, this governs what the
 * operator may do to the *platform*, not to any one business. Presets live in
 * `src/lib/platform-admin.ts`.
 */
export type PlatformAdminRole = "support" | "engineer" | "owner";

export interface PlatformSessionPayload {
  /** platform_admins.id — the operator behind this session. */
  padmin: string;
  role: PlatformAdminRole;
  fullName: string;
  email: string;
}

function getSecret(): Uint8Array {
  // Reuse JWT_SECRET: one deployment, one signing key. The realms are kept
  // apart by cookie name and claim shape, not by a second secret to manage.
  return getJwtSecret("platform sessions");
}

/**
 * Platform sessions are short by default (2h): an operator console is used in
 * bursts, and a forgotten session is a bigger liability here than on the floor.
 * Overridable with PLATFORM_SESSION_HOURS.
 */
export function platformSessionHours(): number {
  const h = Number(process.env.PLATFORM_SESSION_HOURS);
  return Number.isFinite(h) && h > 0 ? h : 2;
}

export async function signPlatformSession(payload: PlatformSessionPayload): Promise<string> {
  return new SignJWT({ ...payload, realm: "platform" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${platformSessionHours()}h`)
    .sign(getSecret());
}

export async function verifyPlatformSession(
  token: string,
): Promise<PlatformSessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    // A tenant token verifies against the same secret, so the realm claim is
    // what actually keeps the two apart. Reject anything not minted here.
    if ((payload as { realm?: string }).realm !== "platform") return null;
    if (typeof (payload as { padmin?: unknown }).padmin !== "string") return null;
    return payload as unknown as PlatformSessionPayload;
  } catch {
    return null;
  }
}

export function platformSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    // Deliberately "/", not "/platform": per RFC 6265 cookie-path matching, a
    // cookie scoped to "/platform" is a directory-prefix match only — it is
    // NEVER sent for a request under "/api/platform/*", since "/api" and
    // "/platform" don't share a path prefix. That silently broke every
    // console API call (login would "succeed" and then every subsequent
    // request would 401, since requirePlatformAdmin never saw the cookie at
    // all). Isolation from the tenant realm was never actually resting on the
    // cookie path anyway — it's the distinct cookie NAME and the `realm`
    // claim check in verifyPlatformSession that keep the two apart, and
    // neither of those is weakened by widening this.
    path: "/",
    maxAge: platformSessionHours() * 60 * 60,
  };
}
