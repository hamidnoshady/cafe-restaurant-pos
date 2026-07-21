/**
 * Server-side helpers for the setup wizard: session/role guard for the
 * /api/setup/* routes and the aggregated wizard state used by the UI.
 */
import { NextResponse } from "next/server";
import { getSession, type SessionPayload } from "./auth";
import { query } from "./db";
import { getSetting, getWizardProgress, SETTING_KEYS, type WizardProgress } from "./settings";

export const WIZARD_STEPS = [
  "business",
  "accounts",
  "costing",
  "tax",
  "users",
  "menu",
  "hardware",
  "opening",
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** Steps that may be skipped and still allow finishing the wizard. */
export const OPTIONAL_STEPS: WizardStep[] = ["users", "hardware", "opening"];

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
  { session: SessionPayload; error: null } | { session: null; error: NextResponse }
> {
  const session = await getSession();
  if (!session) {
    return { session: null, error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  if (session.role !== "owner" && session.role !== "manager") {
    return { session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { session, error: null };
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

export interface SetupState {
  needsBootstrap: boolean;
  business: { id: string; name: string } | null;
  location: { id: string; name: string; address: string | null; phone: string | null } | null;
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
  return Boolean(progress.completedAt);
}

/** The single location the wizard operates on (v1 = one location; more added later). */
export async function getPrimaryLocation(businessId: string) {
  const { rows } = await query<{ id: string; name: string; address: string | null; phone: string | null }>(
    `SELECT id, name, address, phone FROM locations
      WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  return rows[0] ?? null;
}

export async function costingLocked(businessId: string): Promise<boolean> {
  const costing = await getSetting<CostingSetting>(businessId, SETTING_KEYS.costing);
  if (costing?.lockedAt) return true;
  const n = await count(
    `SELECT count(*) AS n FROM stock_movements sm
      JOIN locations l ON l.id = sm.location_id
     WHERE l.business_id = $1`,
    [businessId],
  );
  return n > 0;
}

export async function computeSetupState(businessId: string): Promise<SetupState> {
  const { rows: bizRows } = await query<{ id: string; name: string }>(
    "SELECT id, name FROM businesses WHERE id = $1",
    [businessId],
  );
  const business = bizRows[0] ?? null;
  const location = business ? await getPrimaryLocation(businessId) : null;

  const [prefs, costing, tax, progress] = await Promise.all([
    getSetting<BusinessPrefs>(businessId, SETTING_KEYS.businessPrefs),
    getSetting<CostingSetting>(businessId, SETTING_KEYS.costing),
    getSetting<TaxSetting>(businessId, SETTING_KEYS.tax),
    getWizardProgress(businessId),
  ]);

  const [accounts, users, categories, items, printers, inventoryItems, stockMovements, openingEntries] =
    await Promise.all([
      count("SELECT count(*) AS n FROM accounts WHERE business_id = $1", [businessId]),
      count("SELECT count(*) AS n FROM users WHERE business_id = $1 AND is_active", [businessId]),
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
  if (!progress.steps.business) missingForCompletion.push("اطلاعات کسب‌وکار ثبت نشده است.");
  if (accounts === 0) missingForCompletion.push("سرفصل حساب‌ها ایجاد نشده است.");
  if (!costing) missingForCompletion.push("روش قیمت‌گذاری موجودی انتخاب نشده است.");
  if (!tax) missingForCompletion.push("نرخ مالیات تنظیم نشده است.");
  if (items === 0) missingForCompletion.push("هیچ آیتمی در منو ثبت نشده است.");

  return {
    needsBootstrap: false,
    business,
    location,
    prefs,
    costing: costing ? { ...costing, locked: Boolean(costing.lockedAt) || stockMovements > 0 } : null,
    tax,
    progress,
    counts: { accounts, users, categories, items, printers, inventoryItems },
    hasStockMovements: stockMovements > 0,
    hasOpeningEntry: openingEntries > 0,
    missingForCompletion,
  };
}
