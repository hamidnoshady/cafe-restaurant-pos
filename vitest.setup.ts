/**
 * Environment defaults for a test run, applied by both vitest configs.
 *
 * `getJwtSecret` (src/lib/jwt-secret.ts) refuses an unset or placeholder
 * JWT_SECRET, and vitest does not read `.env` — so `npm test` failed on a fresh
 * clone with 13 failures across auth-edge, platform-auth-edge and webauthn,
 * even though CLAUDE.md's local checklist says to run exactly that. CI already
 * worked around it by setting a throwaway secret in the workflow env; this file
 * is the same idea for a local run, so the documented checklist works as
 * written instead of failing on configuration.
 *
 * It only fills a gap. A JWT_SECRET exported by the developer or by CI always
 * wins, so a run can still be pointed at a specific value. The placeholder from
 * `.env.example` is treated as absent because that is exactly how
 * `getJwtSecret` treats it — a developer who sourced `.env` would otherwise get
 * the same confusing failure with a value visibly "set".
 *
 * Never a production path: `next build` and `tsx server.ts` don't load this
 * file, so the real deployment checks in jwt-secret.ts are untouched. Long
 * enough to satisfy the 32-character production floor, so a suite that stubs
 * NODE_ENV=production doesn't trip over it.
 */
const PLACEHOLDER = "change-me-in-production";

if (!process.env.JWT_SECRET || process.env.JWT_SECRET === PLACEHOLDER) {
  process.env.JWT_SECRET = "test-only-throwaway-secret-0123456789abcdef0123456789abcdef";
}
