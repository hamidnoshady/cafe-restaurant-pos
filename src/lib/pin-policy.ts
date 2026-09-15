/**
 * The PIN policy — pure and client-safe.
 *
 * `team.ts` owns the whole teams story but also imports `node:crypto` (it mints
 * invitation tokens), which makes it unusable from a `"use client"` component.
 * The team screen still needs to answer "is this PIN shape valid" *before* the
 * request leaves, from the same rule the backend gates on — so the rule lives
 * here, imports nothing from Node, and `team.ts` re-exports it for the server
 * callers that already import it from there.
 */

/** Shortest PIN a member may hold — the legacy quick-login length. */
export const PIN_MIN_LENGTH = 4;
/**
 * Longest PIN a member may hold. Phase 42 opened the length up from exactly
 * four, and the owner then raised the ceiling from eight to twelve: 10,000
 * combinations survives a shared-till shoulder-surf, but a member who wants
 * more room gets it (10¹² at the ceiling, and the pad's dots compact past
 * eight so a longer PIN stays easy to type).
 */
export const PIN_MAX_LENGTH = 12;

/**
 * A PIN is 4–12 digits — validated after Persian digits are folded to Latin
 * (callers run toLatinDigits first; this regex is the one backend gate).
 * Deliberately no weak-PIN policy: that would be a product decision this
 * phase wasn't asked to make, and it would reject the `1234` the seed script
 * and the README's demo flow both use. Since Phase 42 the *door*, not the
 * digit count, is what a PIN protects: outside the 7-day OTP window the PIN
 * alone no longer opens it at all (phone-otp-policy.ts).
 */
export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin);
}

/** The human rule, for a hint under an input rather than an error after a 400. */
export const PIN_POLICY_HINT = "رمز عددی باید ۴ تا ۱۲ رقم باشد.";
