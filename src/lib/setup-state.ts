/**
 * Server-side helpers for the setup wizard: session/role guard for the
 * /api/setup/* routes and the aggregated wizard state used by the UI.
 */
import { NextResponse } from "next/server";
import { getSession, type Role, type SessionPayload } from "./auth";
import { query } from "./db";
import {
  accessibleLocationIds,
  canAccessLocation,
  canSwitchBranches,
  defaultAccessibleLocationId,
  type LocationAccessContext,
} from "./location-access";
import { isLocalOnly } from "./deployment-mode";
import {
  getSetting,
  getWizardProgress,
  SETTING_KEYS,
  type WizardProgress,
} from "./settings";
import type { Industry } from "./industries";
// Re-exported for this module's existing importers (the wizard step list
// used to live here) -- moved to wizard-steps.ts because it's also imported
// from client components (src/app/setup/steps.ts), which can't pull in this
// file's next/server and db imports.
export {
  OPTIONAL_STEPS,
  WIZARD_STEPS,
  wizardStepsForIndustry,
  type WizardStep,
} from "./wizard-steps";
import { wizardStepsForIndustry } from "./wizard-steps";

export interface BusinessPrefs {
  currencyDisplay: "toman" | "rial";
  language: "fa";
  calendar: "jalali";
}

export interface CostingSetting {
  method: "fifo" | "weighted_average";
  lockedAt: string | null;
}

export interface TaxSetting {
  /** percent, e.g. 10 */
  defaultRate: number;
}

/** Owner/Manager guard for setup API routes. Returns a response to short-circuit with, or the session. */
export async function requireManager(): Promise<
  | { session: SessionPayload; error: null }
  | { session: null; error: NextResponse }
> {
  const session = await getSession();
  if (!session) {
    return {
      session: null,
      error: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
  if (session.role !== "owner" && session.role !== "manager") {
    return {
      session: null,
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    };
  }
  return { session, error: null };
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

export interface SetupState {
  needsBootstrap: boolean;
  /** True on a standalone desktop install: no online platform, local-drive backup only. */
  localOnly: boolean;
  business: { id: string; name: string; industry: Industry } | null;
  location: {
    id: string;
    name: string;
    address: string | null;
    phone: string | null;
  } | null;
  prefs: BusinessPrefs | null;
  costing: (CostingSetting & { locked: boolean }) | null;
  tax: TaxSetting | null;
  progress: WizardProgress;
  counts: {
    accounts: number;
    users: number;
    categories: number;
    items: number;
    printers: number;
    inventoryItems: number;
  };
  hasStockMovements: boolean;
  hasOpeningEntry: boolean;
  /** requirements still missing before the wizard can be completed */
  missingForCompletion: string[];
}

export async function hasAnyUser(): Promise<boolean> {
  return (await count("SELECT count(*) AS n FROM users", [])) > 0;
}

/** True once the wizard has been formally completed for this business. */
export async function isSetupComplete(businessId: string): Promise<boolean> {
  const progress = await getWizardProgress(businessId);
  if (progress.completedAt) return true;
  const state = await computeSetupState(businessId);
  return state.missingForCompletion.length === 0;
}

export interface LocationRow extends Record<string, unknown> {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
}

/**
 * The first branch created for a business. Used by the setup wizard, which
 * necessarily runs before there is more than one branch to choose between,
 * and by `resolveActiveLocation` as the deterministic tie-breaker for a
 * fully-roaming member (see `location-access.ts`).
 */
export async function getPrimaryLocation(
  businessId: string,
): Promise<LocationRow | null> {
  const { rows } = await query<LocationRow>(
    `SELECT id, name, address, phone FROM locations
      WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  return rows[0] ?? null;
}

/** Every active branch of a business, oldest first — the stable order location-access.ts relies on. */
export async function businessLocations(
  businessId: string,
): Promise<LocationRow[]> {
  const { rows } = await query<LocationRow>(
    `SELECT id, name, address, phone FROM locations
      WHERE business_id = $1 AND is_active ORDER BY created_at`,
    [businessId],
  );
  return rows;
}

/** A membership's role and branch restrictions, as location-access.ts needs them. */
async function locationAccessContext(
  userId: string,
): Promise<LocationAccessContext> {
  const [{ rows: userRows }, { rows: assignmentRows }] = await Promise.all([
    query<{ role: Role; location_id: string | null }>(
      "SELECT role, location_id FROM users WHERE id = $1",
      [userId],
    ),
    query<{ location_id: string }>(
      "SELECT location_id FROM user_locations WHERE user_id = $1",
      [userId],
    ),
  ]);
  return {
    role: userRows[0]?.role ?? "cashier",
    defaultLocationId: userRows[0]?.location_id ?? null,
    assignedLocationIds: assignmentRows.map((r) => r.location_id),
  };
}

/**
 * The branch a request should be scoped to: the session's active branch if
 * the caller can still reach it, otherwise their default accessible branch.
 *
 * This is the Phase 14 replacement for calling `getPrimaryLocation` from a
 * route handler. Role and branch assignment are re-read from the database
 * (not trusted from the session token), for the same reason `requirePermission`
 * does: a membership's assignment can change between login and this request,
 * and access should follow the change rather than the token's age.
 *
 * Deliberately returns the same thing `getPrimaryLocation` always did for a
 * single-location business with no assignments: fully roaming access resolves
 * to that one branch, so this is a no-op for every install that predates
 * Phase 14.
 */
export async function resolveActiveLocation(
  session: SessionPayload,
): Promise<LocationRow | null> {
  const [locations, ctx] = await Promise.all([
    businessLocations(session.businessId),
    locationAccessContext(session.sub),
  ]);
  if (locations.length === 0) return null;

  const ids = locations.map((l) => l.id);
  const requested = session.activeLocationId ?? session.locationId ?? null;
  const targetId =
    requested && canAccessLocation(ctx, ids, requested)
      ? requested
      : defaultAccessibleLocationId(ctx, ids);

  return locations.find((l) => l.id === targetId) ?? null;
}

/** Every branch this session's member may switch to, for the branch switcher UI. */
export async function accessibleLocationsFor(session: SessionPayload): Promise<{
  locations: LocationRow[];
  canSwitch: boolean;
}> {
  const [locations, ctx] = await Promise.all([
    businessLocations(session.businessId),
    locationAccessContext(session.sub),
  ]);
  const ids = locations.map((l) => l.id);
  const accessible = new Set(accessibleLocationIds(ctx, ids));
  return {
    locations: locations.filter((l) => accessible.has(l.id)),
    canSwitch: canSwitchBranches(ctx, ids),
  };
}

export async function costingLocked(businessId: string): Promise<boolean> {
  const costing = await getSetting<CostingSetting>(
    businessId,
    SETTING_KEYS.costing,
  );
  if (costing?.lockedAt) return true;
  const n = await count(
    `SELECT count(*) AS n FROM stock_movements sm
      JOIN locations l ON l.id = sm.location_id
     WHERE l.business_id = $1`,
    [businessId],
  );
  return n > 0;
}

export async function computeSetupState(
  businessId: string,
): Promise<SetupState> {
  const { rows: bizRows } = await query<{
    id: string;
    name: string;
    industry: Industry;
  }>("SELECT id, name, industry FROM businesses WHERE id = $1", [businessId]);
  const business = bizRows[0] ?? null;
  const industry = business?.industry ?? "food_service";
  const steps = wizardStepsForIndustry(industry);
  const location = business ? await getPrimaryLocation(businessId) : null;

  const [prefs, costing, tax, progress, localOnly] = await Promise.all([
    getSetting<BusinessPrefs>(businessId, SETTING_KEYS.businessPrefs),
    getSetting<CostingSetting>(businessId, SETTING_KEYS.costing),
    getSetting<TaxSetting>(businessId, SETTING_KEYS.tax),
    getWizardProgress(businessId),
    isLocalOnly(businessId),
  ]);

  const [
    accounts,
    users,
    categories,
    items,
    printers,
    inventoryItems,
    stockMovements,
    openingEntries,
  ] = await Promise.all([
    count("SELECT count(*) AS n FROM accounts WHERE business_id = $1", [
      businessId,
    ]),
    count(
      "SELECT count(*) AS n FROM users WHERE business_id = $1 AND is_active",
      [businessId],
    ),
    count(
      `SELECT count(*) AS n FROM menu_categories mc JOIN locations l ON l.id = mc.location_id
          WHERE l.business_id = $1`,
      [businessId],
    ),
    count(
      `SELECT count(*) AS n FROM menu_items mi JOIN locations l ON l.id = mi.location_id
          WHERE l.business_id = $1`,
      [businessId],
    ),
    count(
      `SELECT count(*) AS n FROM printers p JOIN locations l ON l.id = p.location_id
          WHERE l.business_id = $1`,
      [businessId],
    ),
    count(
      `SELECT count(*) AS n FROM inventory_items ii JOIN locations l ON l.id = ii.location_id
          WHERE l.business_id = $1`,
      [businessId],
    ),
    count(
      `SELECT count(*) AS n FROM stock_movements sm JOIN locations l ON l.id = sm.location_id
          WHERE l.business_id = $1`,
      [businessId],
    ),
    count(
      `SELECT count(*) AS n FROM journal_entries
          WHERE business_id = $1 AND source_type = 'opening'`,
      [businessId],
    ),
  ]);

  const missingForCompletion: string[] = [];
  if (!progress.steps.business)
    missingForCompletion.push("اطلاعات کسب‌وکار ثبت نشده است.");
  if (accounts === 0)
    missingForCompletion.push("سرفصل حساب‌ها ایجاد نشده است.");
  if (steps.includes("costing") && !costing)
    missingForCompletion.push("روش قیمت‌گذاری موجودی انتخاب نشده است.");
  if (!tax) missingForCompletion.push("نرخ مالیات تنظیم نشده است.");
  if (steps.includes("menu") && items === 0)
    missingForCompletion.push("هیچ آیتمی در منو ثبت نشده است.");

  return {
    needsBootstrap: false,
    localOnly,
    business,
    location,
    prefs,
    costing: costing
      ? { ...costing, locked: Boolean(costing.lockedAt) || stockMovements > 0 }
      : null,
    tax,
    progress,
    counts: { accounts, users, categories, items, printers, inventoryItems },
    hasStockMovements: stockMovements > 0,
    hasOpeningEntry: openingEntries > 0,
    missingForCompletion,
  };
}
