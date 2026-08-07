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

  throw new Error(
    "JWT_SECRET must be set to a real secret."
  );
}
