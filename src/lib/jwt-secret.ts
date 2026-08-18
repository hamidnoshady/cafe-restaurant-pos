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

/**
 * `context` names what is being signed — "sessions", "platform sessions",
 * "webauthn ceremony challenges" — and is reported in the error. It used to
 * exist only for the wording of a dev-fallback warning; when that fallback was
 * removed the parameter was left behind unused, so all three call sites were
 * carefully labelling themselves into a message that threw the label away. The
 * failure that reaches a developer is "JWT_SECRET must be set", with no
 * indication of which key was being resolved or how to produce one.
 */
export function getJwtSecret(context: string): Uint8Array {
  const secret = process.env.JWT_SECRET;
  const isProduction = process.env.NODE_ENV === "production";

  if (secret && secret !== PLACEHOLDER) {
    if (isProduction && secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `JWT_SECRET is only ${secret.length} characters — at least ${MIN_SECRET_LENGTH} are required in ` +
          `production to sign ${context} (e.g. \`openssl rand -hex 32\`).`,
      );
    }
    return new TextEncoder().encode(secret);
  }

  throw new Error(
    `JWT_SECRET must be set to a real secret before signing ${context} — it is ` +
      `either unset or still the "${PLACEHOLDER}" placeholder from .env.example. ` +
      "Generate one with `openssl rand -hex 32`.",
  );
}
