/**
 * Shared JWT_SECRET resolution for both auth realms (auth-edge.ts's tenant
 * sessions, platform-auth-edge.ts's platform sessions) — they sign with the
 * same env var (see platform-auth-edge.ts's own comment on why: one
 * deployment, one signing key, kept apart by cookie name and `realm` claim
 * instead), so the same validation applies to both.
 *
 * Phase 17 security review flagged, but deliberately did not act on, a gap
 * here: the only checks were "is it set" and "is it the placeholder", with
 * no floor on strength — `JWT_SECRET=x` passed silently. That was left as a
 * documented follow-up rather than auto-applied, specifically because
 * tightening it risked breaking a real deployment's CI or production
 * environment sight unseen. Approved and applied now: production refuses a
 * secret under 32 characters (256 bits, the usual HS256 floor), not just an
 * unset or placeholder one.
 */
const PLACEHOLDER = "change-me-in-production";
const MIN_SECRET_LENGTH = 32;

let warned = false;

/** `context` names what's being signed, only for the one-time dev-fallback warning's wording (e.g. "sessions", "platform sessions"). */
export function getJwtSecret(context: string): Uint8Array {
  const secret = process.env.JWT_SECRET;
  const isProduction = process.env.NODE_ENV === "production";

  if (secret && secret !== PLACEHOLDER) {
    if (isProduction && secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `JWT_SECRET is only ${secret.length} characters — at least ${MIN_SECRET_LENGTH} are required in ` +
          "production (e.g. `openssl rand -hex 32`).",
      );
    }
    return new TextEncoder().encode(secret);
  }

  if (isProduction) {
    throw new Error("JWT_SECRET must be set to a real secret in production");
  }
  // NODE_ENV alone is a fragile guard — plenty of real deployments never set
  // it to exactly "production". Make the fallback loud (once, across both
  // realms) rather than silent, so a misconfigured non-dev deployment at
  // least shows up in logs instead of quietly signing every session with a
  // secret checked into this repo's source.
  if (!warned) {
    warned = true;
    console.error(
      `SECURITY WARNING: JWT_SECRET is not set (or is the placeholder) — signing ${context} with a ` +
        "hardcoded, publicly-known development secret. Set a real JWT_SECRET before this is reachable " +
        "by anyone but you.",
    );
  }
  return new TextEncoder().encode("dev-only-insecure-secret");
}
