/**
 * Phase 12 — creating a business.
 *
 * Extracted from the first-run bootstrap route so the same code path serves
 * every way a tenant comes into existence: the first-run wizard today, and
 * Phase 15's super-admin console later. Getting a business created *correctly*
 * — identity, membership, branch and branch assignment, all in one
 * transaction — is exactly the thing that should not be written twice.
 *
 * DB-touching, so per repo convention it has no direct unit test; the pure
 * parts it leans on (slug generation) are covered in slug.test.ts and the
 * transactional behaviour is covered by the tenancy integration test.
 */
import bcrypt from "bcryptjs";
import type { PoolClient } from "pg";
import { getPool, withoutTenantScope } from "./db";
import { slugifyBusinessName, uniqueSlug } from "./slug";
import { FNB_COA_TEMPLATE } from "./coa-template";
import { ENABLED_INDUSTRIES, INDUSTRIES, type Industry } from "./industries";

export interface ProvisionBusinessInput {
  businessName: string;
  locationName?: string;
  address?: string | null;
  phone?: string | null;
  ownerName: string;
  email: string;
  password: string;
  timezone?: string;
  /** Defaults to 'food_service' when omitted — every business before Phase 21 is one. */
  industry?: Industry;
  /**
   * Seed the default F&B chart of accounts as part of provisioning.
   *
   * The first-run wizard leaves this off — it walks the owner through the
   * (editable) chart as a deliberate step. Phase 15's console turns it on, so
   * a business an operator provisions is immediately *working*: the ledger's
   * well-known accounts exist, and the owner can log straight in and sell
   * without a setup detour. See coa-template.ts for the template itself.
   */
  seedChartOfAccounts?: boolean;
}

export interface ProvisionedBusiness {
  businessId: string;
  businessSlug: string;
  locationId: string;
  /** users.id — the owner's membership in the new business. */
  userId: string;
  platformUserId: string;
}

/** An email already registered, offered a *different* password. */
export class EmailPasswordMismatchError extends Error {
  constructor() {
    super("email_password_mismatch");
  }
}

export const DEFAULT_LOCATION_NAME = "شعبه مرکزی";

/**
 * Whether this deployment accepts self-service business registration.
 *
 * Off unless set to exactly "true", and deliberately so: Phase 12 makes a
 * deployment *capable* of holding many businesses, but who may create one is a
 * product decision, not a consequence of the schema. An on-premise café
 * install and a hosted platform want opposite answers. Phase 15's super-admin
 * console provisions businesses regardless of this setting.
 */
export function publicSignupEnabled(): boolean {
  return process.env.ALLOW_PUBLIC_SIGNUP === "true";
}

/** Raw request body shared by first-run bootstrap and self-service signup. */
export interface ProvisionRequestBody {
  businessName?: string;
  locationName?: string;
  address?: string;
  phone?: string;
  ownerName?: string;
  email?: string;
  password?: string;
  industry?: string;
}

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Validates and normalises a provisioning request.
 *
 * Lives here rather than in the route because Next.js route modules may only
 * export handlers — and because both entry points (bootstrap and signup) must
 * apply exactly the same rules. Pure, so it is unit-tested directly.
 */
export function validateProvisionBody(
  body: ProvisionRequestBody,
): { input: ProvisionBusinessInput; error: null } | { input: null; error: string } {
  const businessName = body.businessName?.trim();
  const ownerName = body.ownerName?.trim();
  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";

  if (!businessName || !ownerName || !email || !password) {
    return { input: null, error: "missing_fields" };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { input: null, error: "invalid_email" };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { input: null, error: "weak_password" };
  }

  const industry = (body.industry?.trim() || "food_service") as Industry;
  if (!INDUSTRIES.includes(industry)) {
    return { input: null, error: "invalid_industry" };
  }
  if (!ENABLED_INDUSTRIES.includes(industry)) {
    return { input: null, error: "industry_not_available" };
  }

  return {
    input: {
      businessName,
      locationName: body.locationName?.trim() || undefined,
      address: body.address?.trim() || null,
      phone: body.phone?.trim() || null,
      ownerName,
      email,
      password,
      industry,
    },
    error: null,
  };
}

/**
 * Creates a business, its first branch, and its owner, atomically.
 *
 * The email may already belong to the platform — that is the cross-business
 * identity case, and it is the normal way a group owner opens their second
 * café. When it does, the existing password must be supplied: adding a
 * business to someone's account is an action on *their* identity, so it has to
 * be authenticated as them rather than merely asserted.
 *
 * Runs bypassed throughout, because it creates the tenant that scoping would
 * otherwise have to already exist for.
 */
export async function provisionBusiness(
  input: ProvisionBusinessInput,
): Promise<ProvisionedBusiness> {
  const businessName = input.businessName.trim();
  const locationName = input.locationName?.trim() || DEFAULT_LOCATION_NAME;
  const ownerName = input.ownerName.trim();
  const email = input.email.trim().toLowerCase();

  return withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      // Serialises slug allocation and the identity upsert against a
      // concurrent signup for the same email — neither is protected by a row
      // lock, because in both cases the row may not exist yet.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('business_provisioning'))");

      const { rows: slugRows } = await client.query<{ slug: string }>(
        "SELECT slug::text AS slug FROM businesses",
      );
      const slug = uniqueSlug(
        slugifyBusinessName(businessName),
        slugRows.map((r) => r.slug),
      );

      const { rows: existingIdentity } = await client.query<{
        id: string;
        password_hash: string;
        is_active: boolean;
      }>("SELECT id, password_hash, is_active FROM platform_users WHERE email = $1", [email]);

      let platformUserId: string;
      if (existingIdentity[0]) {
        const identity = existingIdentity[0];
        const ok = identity.is_active && (await bcrypt.compare(input.password, identity.password_hash));
        if (!ok) throw new EmailPasswordMismatchError();
        platformUserId = identity.id;
      } else {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO platform_users (email, password_hash, full_name)
           VALUES ($1, $2, $3) RETURNING id`,
          [email, await bcrypt.hash(input.password, 10), ownerName],
        );
        platformUserId = rows[0].id;
      }

      const { rows: bizRows } = await client.query<{ id: string }>(
        `INSERT INTO businesses (name, slug, timezone, industry) VALUES ($1, $2, $3, $4) RETURNING id`,
        [businessName, slug, input.timezone ?? "Asia/Tehran", input.industry ?? "food_service"],
      );
      const businessId = bizRows[0].id;

      const { rows: locRows } = await client.query<{ id: string }>(
        `INSERT INTO locations (business_id, name, address, phone, timezone)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          businessId,
          locationName,
          input.address?.trim() || null,
          input.phone?.trim() || null,
          input.timezone ?? "Asia/Tehran",
        ],
      );
      const locationId = locRows[0].id;

      // location_id stays NULL: an owner reaches every branch of their
      // business, and pinning them to the first one would be wrong the moment
      // a second branch exists.
      const { rows: userRows } = await client.query<{ id: string }>(
        `INSERT INTO users (business_id, platform_user_id, role, full_name, email, location_id)
         VALUES ($1, $2, 'owner', $3, $4, NULL) RETURNING id`,
        [businessId, platformUserId, ownerName, email],
      );
      const userId = userRows[0].id;

      await client.query(
        `INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, locationId],
      );

      if (input.seedChartOfAccounts) {
        await seedChartOfAccounts(client, businessId);
      }

      await client.query("COMMIT");
      return { businessId, businessSlug: slug, locationId, userId, platformUserId };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Insert the default F&B chart of accounts for a freshly-created business.
 *
 * Runs inside the provisioning transaction (so a failure rolls the whole
 * business back) and mirrors the ordering logic of `/api/setup/accounts`:
 * parents before children, so `parent_id` can be resolved from a code→id map
 * built as we go. FNB_COA_TEMPLATE is already topologically sane (roots first),
 * but resolving by code rather than array position keeps it correct even if
 * the template is later reordered.
 */
async function seedChartOfAccounts(client: PoolClient, businessId: string): Promise<void> {
  const idByCode = new Map<string, string>();
  const pending = [...FNB_COA_TEMPLATE];
  while (pending.length > 0) {
    const ready = pending.filter((a) => !a.parentCode || idByCode.has(a.parentCode));
    // The template is a fixed, cycle-free constant; ready can't be empty.
    for (const a of ready) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO accounts (business_id, parent_id, code, name, type)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [businessId, a.parentCode ? idByCode.get(a.parentCode) : null, a.code, a.name, a.type],
      );
      idByCode.set(a.code, rows[0].id);
      pending.splice(pending.indexOf(a), 1);
    }
  }
}

/** Whether this deployment has any business at all (drives the first-run flow). */
export async function hasAnyBusiness(): Promise<boolean> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await getPool().query("SELECT 1 FROM businesses LIMIT 1");
    return rows.length > 0;
  });
}
