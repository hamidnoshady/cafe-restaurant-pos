/**
 * Billing facade — the one function an important platform feature calls to
 * bill a use, and the purchase flow that turns a verified plan/addon payment
 * into an entitlement.
 *
 * Keeping this seam narrow means feature code never reaches into the wallet
 * or plan catalogue directly: it asks `billFeatureUse(...)` and either
 * continues (charged or free) or catches `FeatureNotEntitledError` /
 * `WalletInsufficientFundsError` and shows the buy-credits prompt.
 */
import { withoutTenantScope } from "./db";
import { chargeFeatureUse, WalletInsufficientFundsError } from "./wallet-service";
import {
  grantEntitlement,
  resolveFeatureAccess,
  type FeatureAccess,
} from "./billing-plans-service";

export { WalletInsufficientFundsError };

export class FeatureNotEntitledError extends Error {
  constructor(public featureKey: string) {
    super("feature_not_entitled");
  }
}

export interface FeatureUseCharge {
  /** False when the use was free (promo / zero price). */
  charged: boolean;
  priceRial: number;
  balanceRial: number;
  access: FeatureAccess;
}

/**
 * Bill one use of a metered feature.
 *
 * - Not entitled at all → FeatureNotEntitledError (UI routes to the plan page).
 * - Entitled but out of credits → WalletInsufficientFundsError (UI top-up prompt).
 * - Free promo / zero price → counted, not charged.
 * - Otherwise → wallet debited, ledger + usage counters updated.
 */
export async function billFeatureUse(input: {
  businessId: string;
  featureKey: string;
  note?: string;
  userId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<FeatureUseCharge> {
  const access = await resolveFeatureAccess(input.businessId, input.featureKey);
  if (!access.entitled) {
    throw new FeatureNotEntitledError(input.featureKey);
  }
  // A per-use feature is metered — even free promo uses count toward a
  // free-for-N-uses limit. An unpriced/included function is not metered here.
  const metered = access.metered;
  const result = await chargeFeatureUse({
    businessId: input.businessId,
    featureKey: input.featureKey,
    priceRial: access.perUsePriceRial,
    note: input.note,
    userId: input.userId ?? null,
    metadata: { ...(input.metadata ?? {}), metered },
  });
  return {
    charged: result.charged,
    priceRial: access.perUsePriceRial,
    balanceRial: result.balanceRial,
    access,
  };
}

/**
 * Record the entitlement a verified purchase grants. Called after a payment
 * settles:
 *  - plan_purchase  → the business's `businesses.plan` is set elsewhere; here
 *                     we stamp the plan's entitled features as owned via plan.
 *  - addon_purchase → one feature owned outright with optional expiry.
 */
/**
 * After a verified plan purchase, switch the business onto that plan so the
 * plan builder's prices become the ones it is billed at. Runs in bypass scope:
 * this is a platform-level change (called from the tenant's own verified
 * payment and from the admin manual-approval route), and the `businesses` row
 * is the same one the existing plan assignment writes.
 */
export async function activatePurchasedPlan(input: {
  businessId: string;
  planKey: string;
}): Promise<void> {
  const { query } = await import("./db");
  await withoutTenantScope("plan_purchase", () =>
    query(`UPDATE businesses SET plan = $2, updated_at = now() WHERE id = $1`, [
      input.businessId,
      input.planKey,
    ]),
  );
}

export async function fulfilPurchasedEntitlement(input: {
  businessId: string;
  featureKey: string;
  source: "addon" | "plan" | "promo";
  expiresAt?: string | null;
  freeUntil?: string | null;
  freeLimit?: number | null;
}): Promise<void> {
  await grantEntitlement({
    businessId: input.businessId,
    featureKey: input.featureKey,
    source: input.source,
    expiresAt: input.expiresAt ?? null,
    freeUntil: input.freeUntil ?? null,
    freeLimit: input.freeLimit ?? null,
  });
}
