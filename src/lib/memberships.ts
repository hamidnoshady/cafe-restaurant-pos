/**
 * Phase 12 — resolving a person to the businesses they can work in.
 *
 * A membership is a row in `users`: one person (`platform_users`) may hold
 * several, one per business, each with its own role, PIN and permissions.
 * See migration 0020 for why `users` kept its identity rather than being
 * replaced by a join table.
 *
 * Everything here runs under `withoutTenantScope` at the caller, because
 * "which businesses does this email belong to" is by definition a question
 * that cannot be asked from inside a single tenant.
 */
import { query } from "./db";
import type { Role } from "./auth-edge";

export interface Membership {
  /** users.id — the membership itself, and what a session's `sub` refers to. */
  userId: string;
  businessId: string;
  businessName: string;
  businessSlug: string;
  businessStatus: "active" | "suspended" | "archived";
  role: Role;
  fullName: string;
  /** Default branch for this membership; null = every branch of the business. */
  locationId: string | null;
}

interface MembershipRow extends Record<string, unknown> {
  user_id: string;
  business_id: string;
  business_name: string;
  business_slug: string;
  business_status: "active" | "suspended" | "archived";
  role: Role;
  full_name: string;
  location_id: string | null;
}

function toMembership(row: MembershipRow): Membership {
  return {
    userId: row.user_id,
    businessId: row.business_id,
    businessName: row.business_name,
    businessSlug: row.business_slug,
    businessStatus: row.business_status,
    role: row.role,
    fullName: row.full_name,
    locationId: row.location_id,
  };
}

const MEMBERSHIP_SELECT = `
  SELECT u.id AS user_id, u.business_id, b.name AS business_name, b.slug::text AS business_slug,
         b.status::text AS business_status, u.role, u.full_name, u.location_id
    FROM users u
    JOIN businesses b ON b.id = u.business_id
`;

/**
 * Every active membership held by one platform identity.
 *
 * Archived businesses are dropped outright; suspended ones are returned so the
 * UI can say *why* a business the person expects to see is unavailable, rather
 * than silently omitting it.
 */
export async function membershipsForPlatformUser(platformUserId: string): Promise<Membership[]> {
  const { rows } = await query<MembershipRow>(
    `${MEMBERSHIP_SELECT}
      WHERE u.platform_user_id = $1
        AND u.is_active
        AND b.status <> 'archived'
      ORDER BY b.name`,
    [platformUserId],
  );
  return rows.map(toMembership);
}

/** One specific membership, used to validate a business switch. */
export async function membershipForBusiness(
  platformUserId: string,
  businessId: string,
): Promise<Membership | null> {
  const { rows } = await query<MembershipRow>(
    `${MEMBERSHIP_SELECT}
      WHERE u.platform_user_id = $1
        AND u.business_id = $2
        AND u.is_active
      LIMIT 1`,
    [platformUserId, businessId],
  );
  return rows[0] ? toMembership(rows[0]) : null;
}

/** Persian reason a membership can't be used to sign in, or null if it can. */
export function membershipBlockedReason(membership: Membership): string | null {
  switch (membership.businessStatus) {
    case "suspended":
      return "دسترسی این کسب‌وکار موقتاً معلق شده است.";
    case "archived":
      return "این کسب‌وکار بایگانی شده است.";
    default:
      return null;
  }
}
