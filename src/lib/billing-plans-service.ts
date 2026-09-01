/**
 * Plan builder: per-feature pricing catalogue on billing plans, business
 * entitlements, and the "free for a limited time / limited use" promotions.
 *
 * Model (migration 0130):
 *  - `billing_plans`       — a plan key with an optional monthly fee.
 *  - `billing_plan_features` — for each (plan, feature) a pricing model:
 *      • included — part of the plan, no extra charge
 *      • monthly  — costs price_rial per month (subscription add-on)
 *      • per_use  — costs price_rial for each use, charged from the wallet
 *      • addon    — one-off purchase, then owned
 *    plus optional `free_until` / `free_limit` promotion fields.
 *  - `business_entitlements` — features a business owns (via plan/addon/promo/
 *    manual grant), with expiry and free-promo allowances copied at grant.
 *  - `feature_usage` — counters; a per_use feature is free until the promo
 *    window closes or `free_limit` uses are consumed.
 *
 * Entitlement resolution order (most specific wins):
 *   manual grant → addon purchase → plan feature → promo row
 */
import { query } from "./db";
import { n, positiveInt } from "./billing-helpers";

/**
 * Postgres `timestamptz` columns come back from node-postgres as JS `Date`
 * objects; every comparison here is an ISO-string lexicographic compare (which
 * is correct only when both sides are strings). Normalize at the boundary.
 */
function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? (typeof value === "string" ? value : null) : d.toISOString();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PricingModel = "included" | "monthly" | "per_use" | "addon";

export interface BillingPlan {
  key: string;
  name: string;
  description: string | null;
  monthlyPriceRial: number | null;
  isActive: boolean;
  sortOrder: number;
}

export interface BillingPlanFeature {
  id: string;
  planKey: string;
  featureKey: string;
  featureName: string | null;
  pricingModel: PricingModel;
  priceRial: number;
  freeUntil: string | null;
  freeLimit: number | null;
  sortOrder: number;
}

export interface FeatureCatalogueEntry {
  key: string;
  name: string;
  description: string | null;
  defaultEnabled: boolean;
}

export interface BusinessEntitlement {
  featureKey: string;
  source: "plan" | "addon" | "promo" | "manual";
  expiresAt: string | null;
  freeUntil: string | null;
  freeLimit: number | null;
}

export interface FeatureAccess {
  featureKey: string;
  /** Entitled at all (plan includes it, addon owned, or active promo). */
  entitled: boolean;
  /** True when this feature is a per-use metered function (price may be 0
   *  during a free promo, but each use still counts toward free limits). */
  metered: boolean;
  /** Per-use price in Rial *right now* — 0 while a free promo applies. */
  perUsePriceRial: number;
  /** True while a free promotion covers this feature. */
  promoActive: boolean;
  /** Free uses remaining (null when there is no usage cap). */
  freeUsesRemaining: number | null;
  /** Entitlement/promo expiry, whichever is sooner and relevant. */
  expiresAt: string | null;
  source: BusinessEntitlement["source"] | null;
}

// ---------------------------------------------------------------------------
// Plan catalogue
// ---------------------------------------------------------------------------

export async function listBillingPlans(activeOnly = false): Promise<BillingPlan[]> {
  const { rows } = await query<{
    key: string;
    name: string;
    description: string | null;
    monthly_price_rial: string | null;
    is_active: boolean;
    sort_order: number;
  }>(
    `SELECT key, name, description, monthly_price_rial, is_active, sort_order
       FROM billing_plans
      WHERE ($1::boolean = false OR is_active)
      ORDER BY sort_order, key`,
    [activeOnly],
  );
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    monthlyPriceRial: r.monthly_price_rial == null ? null : n(r.monthly_price_rial),
    isActive: r.is_active,
    sortOrder: r.sort_order,
  }));
}

export async function saveBillingPlan(input: {
  key?: string;
  name: string;
  description?: string | null;
  monthlyPriceRial?: number | null;
  isActive: boolean;
  sortOrder: number;
}): Promise<BillingPlan> {
  const name = input.name.trim();
  if (!name) throw new Error("missing_fields");
  const key = (input.key ?? "").trim() || slugifyKey(name);
  const price = input.monthlyPriceRial == null ? null : Math.max(0, Math.floor(n(input.monthlyPriceRial)));
  await query(
    `INSERT INTO billing_plans (key, name, description, monthly_price_rial, is_active, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (key) DO UPDATE SET
       name = EXCLUDED.name, description = EXCLUDED.description,
       monthly_price_rial = EXCLUDED.monthly_price_rial,
       is_active = EXCLUDED.is_active, sort_order = EXCLUDED.sort_order,
       updated_at = now()`,
    [key, name, input.description?.trim() || null, price, input.isActive, input.sortOrder || 0],
  );
  // A new billing plan row should also exist in the `plans` limits table so
  // plan-limits.ts and business.plan FK keep working.
  await query(
    `INSERT INTO plans (key, name) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name`,
    [key, name],
  );
  const all = await listBillingPlans();
  const plan = all.find((p) => p.key === key);
  if (!plan) throw new Error("save_failed");
  return plan;
}

function slugifyKey(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || `plan_${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// Feature catalogue + per-plan pricing
// ---------------------------------------------------------------------------

export async function listFeatureCatalogue(): Promise<FeatureCatalogueEntry[]> {
  const { rows } = await query<{
    key: string;
    name: string;
    description: string | null;
    default_enabled: boolean;
  }>(`SELECT key, name, description, default_enabled FROM feature_flags ORDER BY name, key`);
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    defaultEnabled: r.default_enabled,
  }));
}

export async function listPlanFeatures(planKey: string): Promise<BillingPlanFeature[]> {
  const { rows } = await query<{
    id: string;
    plan_key: string;
    feature_key: string;
    feature_name: string | null;
    pricing_model: PricingModel;
    price_rial: string;
    free_until: string | null;
    free_limit: number | null;
    sort_order: number;
  }>(
    `SELECT pf.*, f.name AS feature_name
       FROM billing_plan_features pf
       LEFT JOIN feature_flags f ON f.key = pf.feature_key
      WHERE pf.plan_key = $1
      ORDER BY pf.sort_order, pf.created_at, pf.id`,
    [planKey],
  );
  return rows.map((r) => ({
    id: r.id,
    planKey: r.plan_key,
    featureKey: r.feature_key,
    featureName: r.feature_name,
    pricingModel: r.pricing_model,
    priceRial: n(r.price_rial),
    freeUntil: iso(r.free_until),
    freeLimit: r.free_limit,
    sortOrder: r.sort_order,
  }));
}

export async function savePlanFeature(input: {
  id?: string;
  planKey: string;
  featureKey: string;
  pricingModel: PricingModel;
  priceRial: number;
  freeUntil?: string | null;
  freeLimit?: number | null;
  sortOrder: number;
}): Promise<BillingPlanFeature> {
  if (!["included", "monthly", "per_use", "addon"].includes(input.pricingModel)) {
    throw new Error("bad_pricing_model");
  }
  const price = Math.max(0, Math.floor(n(input.priceRial)));
  if ((input.pricingModel === "per_use" || input.pricingModel === "monthly" || input.pricingModel === "addon") && price <= 0) {
    // A price of zero is legal — it reads as "free" — but the promo columns
    // are the intended free-for-time/use mechanism; zero price simply bills 0.
  }
  const freeLimit =
    input.freeLimit == null || input.freeLimit < 0 ? null : Math.floor(input.freeLimit);
  await query(
    `INSERT INTO billing_plan_features
       (id, plan_key, feature_key, pricing_model, price_rial, free_until, free_limit, sort_order)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (plan_key, feature_key) DO UPDATE SET
       pricing_model = EXCLUDED.pricing_model,
       price_rial = EXCLUDED.price_rial,
       free_until = EXCLUDED.free_until,
       free_limit = EXCLUDED.free_limit,
       sort_order = EXCLUDED.sort_order,
       updated_at = now()
     RETURNING id`,
    [
      input.id ?? null,
      input.planKey,
      input.featureKey,
      input.pricingModel,
      price,
      input.freeUntil ?? null,
      freeLimit,
      input.sortOrder || 0,
    ],
  );
  const all = await listPlanFeatures(input.planKey);
  const row = all.find((f) => f.featureKey === input.featureKey);
  if (!row) throw new Error("save_failed");
  return row;
}

export async function deletePlanFeature(planKey: string, featureKey: string): Promise<void> {
  await query(`DELETE FROM billing_plan_features WHERE plan_key = $1 AND feature_key = $2`, [
    planKey,
    featureKey,
  ]);
}

// ---------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------

export async function listEntitlements(businessId: string): Promise<BusinessEntitlement[]> {
  const { rows } = await query<{
    feature_key: string;
    source: BusinessEntitlement["source"];
    expires_at: string | null;
    free_until: string | null;
    free_limit: number | null;
  }>(
    `SELECT feature_key, source, expires_at, free_until, free_limit
       FROM business_entitlements WHERE business_id = $1
      ORDER BY feature_key`,
    [businessId],
  );
  return rows.map((r) => ({
    featureKey: r.feature_key,
    source: r.source,
    expiresAt: iso(r.expires_at),
    freeUntil: iso(r.free_until),
    freeLimit: r.free_limit,
  }));
}

/** Super-admin: manually grant (or extend) a feature for a business. */
export async function grantEntitlement(input: {
  businessId: string;
  featureKey: string;
  source?: BusinessEntitlement["source"];
  expiresAt?: string | null;
  freeUntil?: string | null;
  freeLimit?: number | null;
  grantedBy?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO business_entitlements
       (business_id, feature_key, source, expires_at, free_until, free_limit, granted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (business_id, feature_key) DO UPDATE SET
       source = EXCLUDED.source,
       expires_at = EXCLUDED.expires_at,
       free_until = EXCLUDED.free_until,
       free_limit = EXCLUDED.free_limit,
       granted_by = EXCLUDED.granted_by,
       updated_at = now()`,
    [
      input.businessId,
      input.featureKey,
      input.source ?? "manual",
      input.expiresAt ?? null,
      input.freeUntil ?? null,
      input.freeLimit == null ? null : Math.max(0, Math.floor(input.freeLimit)),
      input.grantedBy ?? null,
    ],
  );
}

export async function revokeEntitlement(businessId: string, featureKey: string): Promise<void> {
  await query(`DELETE FROM business_entitlements WHERE business_id = $1 AND feature_key = $2`, [
    businessId,
    featureKey,
  ]);
}

// ---------------------------------------------------------------------------
// Effective feature access (the pricing decision used at charge time)
// ---------------------------------------------------------------------------

/**
 * Resolve how one feature stands for a business: whether it is usable and the
 * per-use Rial price in the current moment.
 *
 * A per_use plan feature bills from the wallet; but while its `free_until`
 * date is in the future or `free_limit` uses remain, the price is 0. Features
 * marked `included`/`monthly`/`addon` are entitled when the business has the
 * plan or owns the addon; manual grants always entitle.
 */
export async function resolveFeatureAccess(
  businessId: string,
  featureKey: string,
  now: Date = new Date(),
): Promise<FeatureAccess> {
  const [access] = await resolveFeaturesAccess(businessId, [featureKey], now);
  return access;
}

async function resolveFeatureAccessImpl(
  businessId: string,
  featureKeys: string[],
  now: Date,
): Promise<FeatureAccess[]> {
  const nowIso = now.toISOString();
  const { rows: bizRows } = await query<{ plan: string }>(
    `SELECT plan FROM businesses WHERE id = $1`,
    [businessId],
  );
  const planKey = bizRows[0]?.plan ?? "free";

  const { rows: planFeatures } = await query<{
    feature_key: string;
    pricing_model: PricingModel;
    price_rial: string;
    free_until: string | null;
    free_limit: number | null;
  }>(
    `SELECT feature_key, pricing_model, price_rial, free_until, free_limit
       FROM billing_plan_features
      WHERE plan_key = $1 AND feature_key = ANY($2::text[])`,
    [planKey, featureKeys],
  );

  const { rows: entitlements } = await query<{
    feature_key: string;
    source: BusinessEntitlement["source"];
    expires_at: string | null;
    free_until: string | null;
    free_limit: number | null;
  }>(
    `SELECT feature_key, source, expires_at, free_until, free_limit
       FROM business_entitlements
      WHERE business_id = $1 AND feature_key = ANY($2::text[])`,
    [businessId, featureKeys],
  );

  const { rows: usage } = await query<{
    feature_key: string;
    used_count: string;
  }>(
    `SELECT feature_key, used_count FROM feature_usage
      WHERE business_id = $1 AND feature_key = ANY($2::text[])`,
    [businessId, featureKeys],
  );
  const usedByKey = new Map(usage.map((u) => [u.feature_key, n(u.used_count)]));
  const entByKey = new Map(
    entitlements.map((e) => [
      e.feature_key,
      {
        source: e.source,
        expiresAt: iso(e.expires_at),
        freeUntil: iso(e.free_until),
        freeLimit: e.free_limit == null ? null : n(e.free_limit),
      },
    ]),
  );
  const planByKey = new Map(
    planFeatures.map((f) => [
      f.feature_key,
      { ...f, free_until: iso(f.free_until), free_limit: f.free_limit },
    ]),
  );

  return featureKeys.map((featureKey) => {
    const planFeature = planByKey.get(featureKey);
    const entitlement = entByKey.get(featureKey);
    const usedCount = usedByKey.get(featureKey) ?? 0;

    // Manual / addon entitlement (not expired) → entitled; its free promo may
    // still zero the price of a metered feature.
    const ownedEntitlement =
      entitlement &&
      (entitlement.source === "manual" || entitlement.source === "addon") &&
      (!entitlement.expiresAt || entitlement.expiresAt > nowIso)
        ? entitlement
        : null;

    const promoFromEntitlement =
      entitlement &&
      (entitlement.source === "promo" || entitlement.freeUntil || entitlement.freeLimit != null)
        ? entitlement
        : null;

    const model: PricingModel | null = planFeature?.pricing_model ?? null;
    const price = planFeature ? n(planFeature.price_rial) : 0;

    // A time/use promotion in progress (plan-level promo window still open, or
    // a promo entitlement that has not expired).
    const planFreeUntil = planFeature?.free_until ?? null;
    const planFreeLimit = planFeature?.free_limit ?? null;
    const promoWindowOpen =
      (ownedEntitlement?.freeUntil || promoFromEntitlement?.freeUntil || planFreeUntil
        ? (ownedEntitlement?.freeUntil ?? promoFromEntitlement?.freeUntil ?? planFreeUntil)! > nowIso
        : true);
    const hasAnyPromo =
      planFreeUntil != null ||
      planFreeLimit != null ||
      Boolean(ownedEntitlement?.freeUntil || ownedEntitlement?.freeLimit != null || promoFromEntitlement);
    const activePlanPromo = hasAnyPromo && promoWindowOpen;

    // Entitlement?
    //
    // Billing is opt-in: a feature with NO pricing row is not metered here at
    // all (its access is governed by the existing feature_flags / plan-limit
    // layer, which keeps working unchanged). It reads as entitled and free, so
    // chargeForFeature lets the work through without touching the wallet.
    let entitled = model === null;
    let source: FeatureAccess["source"] = model === null ? "plan" : null;
    if (ownedEntitlement) {
      entitled = true;
      source = ownedEntitlement.source;
    } else if (model === "included" || model === "monthly") {
      // Included/monthly features of the current plan are available. (Monthly
      // fees are collected at plan subscription; the feature itself is on.)
      entitled = true;
      source = "plan";
    } else if (model === "per_use") {
      // Per-use features are reachable (pay as you go), and a running free
      // promotion makes the feature usable outright during its window/quota.
      entitled = true;
      source = activePlanPromo ? "plan" : "plan";
    } else if (model === "addon") {
      // Addons require purchase; the ownedEntitlement branch above handles it,
      // but a promo window can open the feature for free as well.
      entitled = activePlanPromo || (promoFromEntitlement != null && promoWindowOpen);
      if (entitled) source = "promo";
    } else if (promoFromEntitlement && promoWindowOpen) {
      entitled = true;
      source = "promo";
    }

    // Free promotion resolution — plan-level promo OR promo entitlement.
    const freeUntil =
      ownedEntitlement?.freeUntil ??
      promoFromEntitlement?.freeUntil ??
      planFeature?.free_until ??
      null;
    const freeLimit =
      ownedEntitlement?.freeLimit ??
      promoFromEntitlement?.freeLimit ??
      planFeature?.free_limit ??
      null;
    // A promo is a time window and/or a use quota. It is active while the
    // window is open AND the quota (if any) is not exhausted: a time-only
    // promo needs `freeUntil` in the future; a use-only promo needs remaining
    // free uses; both together need both.
    const windowOpen = freeUntil == null ? true : freeUntil > nowIso;
    const quotaRemains = freeLimit == null ? true : usedCount < freeLimit;
    const hasPromo = freeUntil != null || freeLimit != null;
    const promoActive = hasPromo && windowOpen && quotaRemains;

    let perUsePrice = 0;
    if (model === "per_use") {
      perUsePrice = promoActive ? 0 : price;
    } else if (model === "addon") {
      perUsePrice = 0; // owned outright; purchase price handled at buy time
    }

    const expiresAt =
      ownedEntitlement?.expiresAt ??
      (freeUntil && freeUntil > nowIso ? freeUntil : null);

    let freeUsesRemaining: number | null = null;
    if (freeLimit != null) {
      freeUsesRemaining = Math.max(0, freeLimit - usedCount);
    }

    return {
      featureKey,
      entitled,
      metered: model === "per_use",
      perUsePriceRial: perUsePrice,
      promoActive,
      freeUsesRemaining,
      expiresAt,
      source,
    };
  });
}

/** Batch version for the billing page / nav badge. */
export async function resolveFeaturesAccess(
  businessId: string,
  featureKeys: string[],
  now: Date = new Date(),
): Promise<FeatureAccess[]> {
  if (featureKeys.length === 0) return [];
  return resolveFeatureAccessImpl(businessId, featureKeys, featureKeys.length ? now : new Date());
}

/**
 * The per-use price a caller should charge for one use of a feature, or null
 * when the feature is not metered (included/owned → no wallet charge).
 */
export async function perUsePriceFor(
  businessId: string,
  featureKey: string,
): Promise<{ priceRial: number; entitled: boolean }> {
  const access = await resolveFeatureAccess(businessId, featureKey);
  if (!access.entitled) return { priceRial: -1, entitled: false };
  return { priceRial: access.perUsePriceRial, entitled: true };
}

export { positiveInt };
