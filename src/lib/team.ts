/**
 * Phase 13 — teams & permissions: the framework-free half.
 *
 * Invitation tokens and the rules that stop a business locking itself out of
 * its own account. Both are pure and unit-tested (team.test.ts); everything
 * that touches the database lives in team-service.ts.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Role } from "./auth-edge";
import { ALL_PERMISSIONS, type PermissionOverrides } from "./permissions";

// ---------------------------------------------------------------------------
// Invitation tokens
// ---------------------------------------------------------------------------

/** How long an invitation stays usable. Long enough to be practical, short enough to expire. */
export const INVITATION_TTL_DAYS = 7;

/** Prefix makes a leaked token recognisable in a log or a paste. */
const TOKEN_PREFIX = "inv_";

/**
 * A new invitation token: the plaintext to hand to the invitee, and the hash
 * to store.
 *
 * Only the hash is persisted (migration 0022), so the plaintext is shown once
 * and is unrecoverable afterwards — the same rule the Phase 9 rollup tokens
 * follow. A database read can never yield a usable invitation.
 */
export function generateInvitationToken(): { token: string; tokenHash: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
  return { token, tokenHash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function invitationExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export interface InvitationState {
  expiresAt: Date | string;
  acceptedAt: Date | string | null;
  revokedAt: Date | string | null;
}

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

/** Why an invitation can't be used, or "pending" when it can. */
export function invitationStatus(
  invitation: InvitationState,
  now: Date = new Date(),
): InvitationStatus {
  if (invitation.acceptedAt) return "accepted";
  if (invitation.revokedAt) return "revoked";
  if (new Date(invitation.expiresAt).getTime() <= now.getTime()) return "expired";
  return "pending";
}

// ---------------------------------------------------------------------------
// Roles an owner may hand out
// ---------------------------------------------------------------------------

/**
 * Roles that authenticate with an email and password (and therefore need a
 * global identity), versus roles that use a numeric PIN on a shared device.
 */
export const PASSWORD_ROLES: Role[] = ["owner", "manager", "accountant"];
export const PIN_ROLES: Role[] = ["cashier", "waiter", "kitchen"];

export function isPasswordRole(role: Role): boolean {
  return PASSWORD_ROLES.includes(role);
}

export function isPinRole(role: Role): boolean {
  return PIN_ROLES.includes(role);
}

// ---------------------------------------------------------------------------
// Lockout guards
// ---------------------------------------------------------------------------

/**
 * A business's members, reduced to what the lockout rules need to know.
 * `id` is users.id — the membership, not the person.
 */
export interface MemberSummary {
  id: string;
  role: Role;
  isActive: boolean;
}

export type LockoutReason = "last_owner" | null;

/**
 * Whether a business would still have a way in after this change.
 *
 * Decision (Phase 13 Q2): a business may have **several owners**. That makes
 * this a counting rule rather than a "the owner is special" rule: the last
 * *active* owner cannot be demoted, suspended or removed, but any owner above
 * that floor can be.
 *
 * Without this, an owner could demote themselves to cashier and leave the
 * business with nobody able to manage the team, invite anyone, or undo it —
 * recoverable only by a developer with database access.
 */
export function checkLastOwner(
  members: MemberSummary[],
  targetId: string,
  change: { role?: Role; isActive?: boolean; remove?: boolean },
): LockoutReason {
  const target = members.find((m) => m.id === targetId);
  if (!target) return null;

  // Only changes that take an active owner *out* of the owner set can lock anyone out.
  const wasActiveOwner = target.role === "owner" && target.isActive;
  if (!wasActiveOwner) return null;

  const stillActiveOwner =
    !change.remove &&
    (change.role ?? target.role) === "owner" &&
    (change.isActive ?? target.isActive);
  if (stillActiveOwner) return null;

  const otherActiveOwners = members.filter(
    (m) => m.id !== targetId && m.role === "owner" && m.isActive,
  ).length;

  return otherActiveOwners === 0 ? "last_owner" : null;
}

/** Persian message for a lockout refusal. */
export function lockoutMessage(reason: Exclude<LockoutReason, null>): string {
  switch (reason) {
    case "last_owner":
      return "این تنها مالک فعال کسب‌وکار است؛ ابتدا مالک دیگری اضافه کنید.";
  }
}

// ---------------------------------------------------------------------------
// Permission override validation
// ---------------------------------------------------------------------------

/**
 * Cleans a permission-override payload coming from the team UI.
 *
 * Unknown keys are dropped rather than rejected — the catalogue changes
 * between releases and a stale browser tab shouldn't produce a 400. A key in
 * both lists is kept in both; `effectivePermissions` already resolves that
 * deterministically (revoke wins), so there is no ambiguity to reject.
 */
export function sanitizeOverrides(input: unknown): PermissionOverrides {
  const known = new Set<string>(ALL_PERMISSIONS);
  const clean = (value: unknown): string[] =>
    Array.isArray(value)
      ? [...new Set(value.filter((v): v is string => typeof v === "string" && known.has(v)))].sort()
      : [];

  // Always the same shape, including for junk input, so callers never have to
  // distinguish "no overrides" from "unusable overrides".
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { granted: [], revoked: [] };
  }
  const raw = input as Record<string, unknown>;
  return { granted: clean(raw.granted), revoked: clean(raw.revoked) };
}

/** True when the overrides carry no actual adjustment (so it can be stored as {}). */
export function overridesAreEmpty(overrides: PermissionOverrides): boolean {
  return (overrides.granted?.length ?? 0) === 0 && (overrides.revoked?.length ?? 0) === 0;
}

// ---------------------------------------------------------------------------
// PINs
// ---------------------------------------------------------------------------

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
