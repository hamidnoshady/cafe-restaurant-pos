/**
 * Session primitives that are safe to run in the Edge runtime.
 *
 * `src/middleware.ts` runs on Edge, where `node:async_hooks` does not exist —
 * and since Phase 12 `src/lib/auth.ts` pulls in the tenant context (which is
 * built on AsyncLocalStorage) and the database pool. Splitting the pure token
 * handling out keeps the middleware bundle free of both, while `auth.ts`
 * re-exports everything here so the ~93 route handlers that import from
 * `@/lib/auth` are unaffected.
 *
 * Everything in this file depends only on `jose`, which works in both runtimes.
 */
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "pos_session";

/**
 * A membership's role within one business.
 *
 * `accountant` arrived with Phase 12 for the accounting suite in Phase 16: it
 * works the books without touching the till or the floor.
 */
export type Role = "owner" | "manager" | "accountant" | "cashier" | "waiter" | "kitchen";

export interface SessionPayload {
  /** users.id — the *membership* acting, not the person. See migration 0020. */
  sub: string;
  role: Role;
  /** The tenant every query in this request will be scoped to. */
  businessId: string;
  /** Active branch; null = all branches of this business (owner / roaming manager). */
  locationId: string | null;
  fullName: string;
  /**
   * platform_users.id — the person behind the membership, present only for
   * password logins. PIN-only staff have no global identity. Carried so
   * "switch business" can find this person's other memberships without a
   * second authentication.
   */
  platformUserId?: string | null;
}

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === "change-me-in-production") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET must be set to a real secret in production");
    }
    return new TextEncoder().encode("dev-only-insecure-secret");
  }
  return new TextEncoder().encode(secret);
}

export function sessionHours(): number {
  const h = Number(process.env.SESSION_HOURS);
  return Number.isFinite(h) && h > 0 ? h : 12;
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${sessionHours()}h`)
    .sign(getSecret());
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: sessionHours() * 60 * 60,
  };
}
