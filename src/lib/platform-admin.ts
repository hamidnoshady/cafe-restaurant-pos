/**
 * Phase 15 — what each platform-admin role may do.
 *
 * Answering open question 3 (differentiated platform roles): one level is not
 * enough. The console has surfaces of very different danger, and reserving the
 * dangerous ones for the most trusted operators is cheaper than trusting every
 * admin equally.
 *
 *   - support  — the day-to-day desk. Reads everything, and may enter a
 *     business *read-only* to see what a customer sees. Changes nothing.
 *   - engineer — support, plus the write side of operations: feature flags,
 *     suspend/reactivate, system/job controls. Cannot provision, cannot
 *     hard-delete, cannot take full-access control of a business.
 *   - owner    — the whole console: provisioning, archive/hard-delete, granting
 *     full-access impersonation, and managing other platform admins.
 *
 * This module is pure — the single place the role→capability mapping lives, so
 * it can be unit-tested directly and both the API guard and the console UI ask
 * the same question and get the same answer.
 */
import type { PlatformAdminRole } from "./platform-auth-edge";

export type { PlatformAdminRole };

export const PLATFORM_ADMIN_ROLES: PlatformAdminRole[] = ["support", "engineer", "owner"];

/** Every discrete thing the console can do, gated independently of the pages. */
export type PlatformCapability =
  // Read surfaces
  | "businesses.read"
  | "audit.read"
  | "system.read"
  | "usage.read"
  // Operational writes
  | "features.write"
  | "business.suspend"
  // Owner-only business data operations
  | "business.edit"
  | "business.reset"
  // Impersonation, split by blast radius
  | "impersonate.readOnly"
  | "impersonate.full"
  | "impersonate.revoke"
  // Owner-only, most dangerous
  | "business.provision"
  | "business.archive"
  | "business.delete"
  | "admins.manage";

const READ: PlatformCapability[] = ["businesses.read", "audit.read", "system.read", "usage.read"];

/**
 * The capabilities each role holds. Higher roles are supersets of lower ones,
 * spelled out rather than inherited so a reviewer sees exactly what each role
 * can do without tracing an inheritance chain.
 */
const CAPABILITIES: Record<PlatformAdminRole, PlatformCapability[]> = {
  support: [...READ, "impersonate.readOnly"],
  engineer: [
    ...READ,
    "impersonate.readOnly",
    "features.write",
    "business.suspend",
    "impersonate.revoke",
  ],
  owner: [
    ...READ,
    "impersonate.readOnly",
    "features.write",
    "business.suspend",
    "impersonate.revoke",
    "impersonate.full",
    "business.provision",
    "business.archive",
    "business.delete",
    "business.edit",
    "business.reset",
    "admins.manage",
  ],
};

export function platformCan(role: PlatformAdminRole, capability: PlatformCapability): boolean {
  return CAPABILITIES[role]?.includes(capability) ?? false;
}

/**
 * The full capability list a role holds — what `auth/me` ships to the console
 * so the UI hides controls the operator could not use anyway. The server still
 * re-checks every write with `platformCan`; this is only to keep the UI honest.
 */
export function CAPABILITIES_FOR(role: PlatformAdminRole): PlatformCapability[] {
  return [...(CAPABILITIES[role] ?? [])];
}


/** Persian labels for the platform-admin roles, for the console UI. */
export const PLATFORM_ROLE_LABELS: Record<PlatformAdminRole, string> = {
  support: "پشتیبانی",
  engineer: "مهندس",
  owner: "مدیر ارشد",
};

/**
 * How long an impersonation window may last, in minutes. Deliberately short:
 * support access is for a specific look, not a standing seat inside a business.
 * Requested longer than this is clamped to it.
 */
export const MAX_IMPERSONATION_MINUTES = 60;
export const DEFAULT_IMPERSONATION_MINUTES = 30;

export function clampImpersonationMinutes(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_IMPERSONATION_MINUTES;
  }
  return Math.min(Math.floor(requested), MAX_IMPERSONATION_MINUTES);
}

/**
 * Days an archived business must wait before it becomes eligible for
 * hard-delete (open question 2: grace window + export, never immediate).
 * Overridable per deployment.
 */
export function deleteGraceDays(): number {
  const d = Number(process.env.PLATFORM_DELETE_GRACE_DAYS);
  return Number.isFinite(d) && d >= 0 ? Math.floor(d) : 30;
}

/**
 * Whether a business archived at `archivedAt` is past its grace window as of
 * `now`, and therefore eligible for hard-delete. Pure so it can be tested
 * without touching the clock or the database.
 */
export function isDeleteEligible(
  archivedAt: Date | string | null,
  now: Date = new Date(),
  graceDays: number = deleteGraceDays(),
): boolean {
  if (!archivedAt) return false;
  const archived = archivedAt instanceof Date ? archivedAt : new Date(archivedAt);
  if (Number.isNaN(archived.getTime())) return false;
  const eligibleAt = archived.getTime() + graceDays * 24 * 60 * 60 * 1000;
  return now.getTime() >= eligibleAt;
}
