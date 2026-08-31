/**
 * Phase 24 Wave 2 — the pure part of the two-factor rule.
 *
 * Deliberately free of imports so it can be unit-tested directly and reused by
 * both auth realms: `enrolmentRequirement` answers "does this account have to
 * do something about 2FA right now", and nothing else. Everything that touches
 * the database lives in `mfa-service.ts`.
 */

export type MfaRequirement = "not_required" | "grace" | "required";

export interface AccountMfaState {
  hasPrimary: boolean;
  graceUntil: Date | null;
  role: string;
  hasGraceRecord: boolean;
}

/**
 * Grace window lengths, in days.
 *
 * Platform admins get half of what a business Owner does: a small, known set
 * of people holding the most power on the platform, so the window that exists
 * to stop a deploy locking everyone out at once does not need to be long.
 */
export const MFA_GRACE_DAYS_TENANT = 14;
export const MFA_GRACE_DAYS_PLATFORM = 7;

export function enrolmentRequirement(state: AccountMfaState, now: Date = new Date()): MfaRequirement {
  if (state.hasPrimary) {
    return "not_required";
  }

  // Not enrolled. Do they require it?
  // We check if they have grace.
  if (state.hasGraceRecord) {
    if (state.graceUntil && state.graceUntil.getTime() > now.getTime()) {
      return "grace";
    }
    return "required";
  }

  return "grace";
}

/**
 * Whole days left of a grace window, rounded up and floored at zero.
 *
 * Rounded *up* because the nag reads «۳ روز باقی مانده» and a window that
 * expires in eleven hours must not read «۰ روز» while login still works — the
 * countdown is a warning, and understating it is the failure that matters.
 * Returns null when there is no window to count (already enrolled, or the
 * grace record has not been stamped yet).
 */
export function graceDaysRemaining(graceUntil: Date | null, now: Date = new Date()): number | null {
  if (!graceUntil) return null;
  const ms = graceUntil.getTime() - now.getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/**
 * Whether a business role has to carry a second factor.
 *
 * `owner` always: it is the full permission set by construction. `manager` is
 * the documented opt-in — a business may extend the requirement to its
 * managers, off by default, because on a small café the manager role is worn
 * by whoever is on shift and a hard 2FA gate there would stop service. Every
 * other role (cashier, waiter, kitchen) signs in by PIN on a shared till and is
 * out of scope for this wave entirely.
 */
export function mfaAppliesToRole(role: string, extendToManager = false): boolean {
  if (role === "owner") return true;
  if (role === "manager") return extendToManager;
  return false;
}
