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
 * Phase 17 security review — the tenant and platform-admin realms share one
 * JWT_SECRET (platform-auth-edge.ts reads the same env var). That file
 * already stamps a `realm: "platform"` claim and rejects any token missing
 * or mismatching it, so a tenant token was already refused there — but this
 * side never checked the reverse: a platform token verifies fine against
 * `verifySession` today, since nothing here looks at `realm` at all. Stamping
 * and requiring `realm: "tenant"` (below) closes that direction too, the
 * same way, rather than inventing a second convention.
 */
const REALM = "tenant";

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
  /** This membership's default/home branch; null = roaming (owner or unassigned manager). */
  locationId: string | null;
  /**
   * Phase 14 — the branch currently "in view" for scoped screens, chosen via
   * `/api/auth/switch-location`. Undefined on tokens issued before Phase 14
   * (and briefly after login, before a switch): `resolveActiveLocation`
   * (src/lib/setup-state.ts) treats that the same as an inaccessible branch
   * and falls back to the member's default accessible one, so an old token
   * degrades gracefully rather than needing everyone to re-log-in.
   */
  activeLocationId?: string | null;
  fullName: string;
  /**
   * platform_users.id — the person behind the membership, present only for
   * password logins. PIN-only staff have no global identity. Carried so
   * "switch business" can find this person's other memberships without a
   * second authentication.
   */
  platformUserId?: string | null;
  /**
   * Phase 15 — set only when this tenant session was minted by the super-admin
   * console entering the business (impersonation). It names the grant, the
   * platform admin behind it, and the blast radius. Its presence is what the
   * middleware and guards key on to (a) block every mutating request when the
   * mode is `read_only`, and (b) tag the acting session as an operator, not the
   * owner whose seat it borrows. A normal tenant login never carries it.
   */
  imp?: {
    /** impersonation_grants.id — re-checked live on the server, never trusted alone. */
    grantId: string;
    /** platform_admins.id — the operator accountable for anything done here. */
    adminId: string;
    mode: "read_only" | "full";
  };
}


let warnedInsecureSecret = false;

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === "change-me-in-production") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET must be set to a real secret in production");
    }
    // NODE_ENV alone is a fragile guard — plenty of real deployments never
    // set it to exactly "production". Make the fallback loud (once) rather
    // than silent, so a misconfigured non-dev deployment at least shows up in
    // logs instead of quietly signing every session with a secret checked
    // into this repo's source.
    if (!warnedInsecureSecret) {
      warnedInsecureSecret = true;
      console.error(
        "SECURITY WARNING: JWT_SECRET is not set (or is the placeholder) — signing sessions with a " +
          "hardcoded, publicly-known development secret. Set a real JWT_SECRET before this is reachable " +
          "by anyone but you.",
      );
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
  return new SignJWT({ ...payload, realm: REALM })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${sessionHours()}h`)
    .sign(getSecret());
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    // A platform-admin token verifies against the same secret, so the realm
    // claim is what actually keeps the two apart. Reject anything not
    // minted here — including a token from before this claim existed.
    if ((payload as { realm?: string }).realm !== REALM) return null;
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
