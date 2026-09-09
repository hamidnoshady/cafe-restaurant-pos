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
  | "ai.read"
  // Operational writes
  | "features.write"
  // Migration 0132 — the whole-system backup the console owns: its schedule and
  // destinations, its run history, and the peer tokens that let another server
  // pull artifacts from this one. An engineer may operate it because backing up
  // is ordinary operations, like flags and suspension: it reads everything and
  // overwrites nothing. …
  | "backup.manage"
  // Migration 0139 — administering the website platform (eshobe-cms) from this
  // console: its address and platform key, a site's lifecycle, issuing and revoking
  // site keys, and syncing content in either direction. An engineer holds it for the
  // same reason they hold `backup.manage`: keeping the fleet's websites serving is
  // ordinary operations, and the alternative is an operator opening the CMS's own
  // admin on another host, where nothing this console does is audited. Reading the
  // CMS report rides `system.read` — knowing that four domains are unverified is not
  // privileged information.
  | "cms.manage"
  | "business.suspend"
  | "ai.credits.manage"
  // Platform billing: gateway config, credit packages, plan builder, wallet
  // grants and payment approval.
  | "billing.manage"
  // Owner-only business data operations
  | "business.edit"
  | "business.reset"
  // Learning content: the per-section knowledge-base URLs every business's
  // «آموزش» modal opens.
  | "knowledge.manage"
  // The support desk (migration 0130): reading and answering every business's
  // support tickets. Given to every admin role — answering tickets is the
  // `support` role's whole job, and there is no read-only half worth
  // separating: the console's ticket page is read surfaces plus the reply box,
  // and every write is audited.
  | "support.manage"
  // Impersonation, split by blast radius
  | "impersonate.readOnly"
  | "impersonate.full"
  | "impersonate.revoke"
  // …but *replacing this server's entire database* with another server's is not
  // an operations task: it is the one console action that can destroy more data
  // than deleting every business on the platform, so it needs `backup.restore`,
  // which no role but owner holds.
  | "backup.restore"
  // Owner-only, most dangerous
  | "business.provision"
  | "business.archive"
  | "business.delete"
  | "admins.manage"
  // Owner-only — holds real platform secrets and price policy.
  | "updates.manage"
  | "ai.config.manage";

const READ: PlatformCapability[] = ["businesses.read", "audit.read", "system.read", "usage.read", "ai.read"];

/**
 * The capabilities each role holds. Higher roles are supersets of lower ones,
 * spelled out rather than inherited so a reviewer sees exactly what each role
 * can do without tracing an inheritance chain.
 */
const CAPABILITIES: Record<PlatformAdminRole, PlatformCapability[]> = {
  support: [...READ, "support.manage", "impersonate.readOnly"],
  engineer: [
    ...READ,
    "support.manage",
    "impersonate.readOnly",
    "features.write",
    "business.suspend",
    "ai.credits.manage",
    "billing.manage",
    "impersonate.revoke",
    "knowledge.manage",
    "backup.manage",
    "cms.manage",
  ],
  owner: [
    ...READ,
    "support.manage",
    "impersonate.readOnly",
    "features.write",
    "business.suspend",
    "ai.credits.manage",
    "billing.manage",
    "impersonate.revoke",
    "knowledge.manage",
    "backup.manage",
    "cms.manage",
    "backup.restore",
    "impersonate.full",
    "business.provision",
    "business.archive",
    "business.delete",
    "business.edit",
    "business.reset",
    "admins.manage",
    "updates.manage",
    "ai.config.manage",
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
 * The fixed phrase an operator must type to reset or hard-delete a business.
 * Both are immediate and irreversible with no other safety net (no archive
 * step, no grace window) — a single memorable phrase rather than the
 * business's own slug, which a Persian business name makes tedious to
 * retype exactly.
 */
export const DESTRUCTIVE_CONFIRMATION_PHRASE = "delete-me";
