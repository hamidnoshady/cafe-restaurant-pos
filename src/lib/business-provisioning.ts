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
import {
  SLUG_FALLBACK,
  slugifyBusinessName,
  subdomainFromBusinessName,
  uniqueSlug,
  validateSubdomain,
} from "./slug";
import { LOCAL_DISABLED_FEATURES, type DeploymentModeName } from "./deployment-mode";
import { SETTING_KEYS } from "./settings";
import { coaTemplateForIndustry, nextAccountLevel, type AccountLevel, type TemplateAccount } from "./coa-template";
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
  /**
   * How this install relates to the online platform. 'local' stamps the
   * deployment-mode setting and seeds `business_features` overrides turning
   * off everything that needs the platform to work (see
   * LOCAL_DISABLED_FEATURES). Absent means 'connected', which writes nothing
   * — so every existing caller (the online console, public signup) is
   * unchanged.
   */
  deploymentMode?: DeploymentModeName;
  /**
   * Phase 23 — the public host label, when the caller has one in mind (the
   * console's add form offers it, prefilled and editable). Omitted, it is
   * derived from the business name the same way the slug is. Either way it is
   * made unique before it is written.
   */
  subdomain?: string;
}

export interface ProvisionedBusiness {
  businessId: string;
  businessSlug: string;
  /** Phase 23 — the origin the new business is served from. */
  businessSubdomain: string;
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
  /** Phase 23 — the public host label. Derived from the name when omitted. */
  subdomain?: string;
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

  // Phase 23 — an explicitly requested subdomain is validated as a DNS label
  // here rather than silently normalised, because the admin typed it and is
  // going to hand the resulting URL to a customer. Omitted, it is derived from
  // the business name inside provisionBusiness.
  const subdomain = body.subdomain?.trim().toLowerCase();
  if (subdomain) {
    const invalid = validateSubdomain(subdomain);
    if (invalid) return { input: null, error: invalid };
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
      subdomain: subdomain || undefined,
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

      const { rows: slugRows } = await client.query<{ slug: string; subdomain: string }>(
        "SELECT slug::text AS slug, subdomain::text AS subdomain FROM businesses",
      );
      const slug = uniqueSlug(
        slugifyBusinessName(businessName),
        slugRows.map((r) => r.slug),
      );

      // Phase 23: the public host, allocated in the same advisory-locked
      // transaction as the slug so two concurrent signups can't claim one
      // origin. `taken` is the subdomain column, not the slug column — the two
      // are independent namespaces the moment anyone renames a subdomain, and
      // checking the wrong one would let a rename's freed name be handed out
      // while its alias still resolves. An explicitly requested subdomain is
      // validated by the caller (the console); uniqueSlug only settles
      // collisions, appending -2, -3, … the same way it does for slugs.
      const subdomain = uniqueSlug(
        subdomainFromBusinessName(input.subdomain?.trim() || businessName) || SLUG_FALLBACK,
        slugRows.map((r) => r.subdomain),
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
        `INSERT INTO businesses (name, slug, subdomain, timezone, industry)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [businessName, slug, subdomain, input.timezone ?? "Asia/Tehran", input.industry ?? "food_service"],
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
        await seedChartOfAccounts(client, businessId, input.industry ?? "food_service");
      }

      // Local-only installs record the mode and turn off the platform-dependent
      // features in the same transaction that creates the business, so there is
      // never a window where a local install looks like a connected one.
      if (input.deploymentMode === "local") {
        await client.query(
          `INSERT INTO settings (business_id, location_id, key, value)
           VALUES ($1, NULL, $2, $3)`,
          [businessId, SETTING_KEYS.deploymentMode, JSON.stringify({ mode: "local", pairedAt: null })],
        );
        for (const flagKey of LOCAL_DISABLED_FEATURES) {
          await client.query(
            `INSERT INTO business_features (business_id, flag_key, enabled)
             SELECT $1, $2, false
              WHERE EXISTS (SELECT 1 FROM feature_flags WHERE key = $2)
             ON CONFLICT (business_id, flag_key) DO UPDATE SET enabled = false, updated_at = now()`,
            [businessId, flagKey],
          );
        }
      }

      await client.query("COMMIT");
      return { businessId, businessSlug: slug, businessSubdomain: subdomain, locationId, userId, platformUserId };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Insert the industry-appropriate default chart of accounts for a freshly-created business.
 *
 * Runs inside the provisioning transaction (so a failure rolls the whole
 * business back) and mirrors the ordering logic of `/api/setup/accounts`:
 * parents before children, so `parent_id` can be resolved from a code→id map
 * built as we go. Each template is already topologically sane (roots first),
 * but resolving by code rather than array position keeps it correct even if
 * a template is later reordered.
 */
async function seedChartOfAccounts(client: PoolClient, businessId: string, industry: Industry): Promise<void> {
  const idByCode = new Map<string, string>();
  const levelByCode = new Map<string, AccountLevel>();
  const pending = [...coaTemplateForIndustry(industry)];
  while (pending.length > 0) {
    const ready = pending.filter((a) => !a.parentCode || idByCode.has(a.parentCode));
    // The template is a fixed, cycle-free constant; ready can't be empty, and
    // it's never nested past four levels, so nextAccountLevel never returns
    // null here.
    for (const a of ready) {
      const level = nextAccountLevel(a.parentCode ? (levelByCode.get(a.parentCode) ?? null) : null)!;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [businessId, a.parentCode ? idByCode.get(a.parentCode) : null, a.code, a.name, a.type, level, a.isContra ?? false],
      );
      idByCode.set(a.code, rows[0].id);
      levelByCode.set(a.code, level);
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
