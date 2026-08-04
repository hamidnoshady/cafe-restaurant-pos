/**
 * Online ordering platform settings (issue #160 §4 — the last of Wave 4's
 * three deferrals). DB-touching, thin wrapper over the settings table —
 * not unit-tested directly, per repo convention.
 *
 * Only SnapFood exists as a platform for now (per the business owner);
 * there's no per-order commission feed (no documented PartnerFood
 * integration surface — see migrations/0060's comment), so the commission
 * rate is a single business-wide setting the owner keeps in sync with their
 * actual SnapFood contract, applied to every SnapFood-marked sale at
 * checkout. `null` until an owner sets one — a SnapFood sale still works
 * with no commission configured (see postExactOrderPaymentEntry), it just
 * won't split anything to platformCommissionExpense yet.
 */
import { getSetting, setSetting, SETTING_KEYS } from "./settings";

export interface OnlinePlatformsConfig {
  snappfood: { commissionPercent: number } | null;
}

export async function getOnlinePlatformsConfig(businessId: string): Promise<OnlinePlatformsConfig> {
  const stored = await getSetting<OnlinePlatformsConfig>(businessId, SETTING_KEYS.onlinePlatforms);
  return { snappfood: stored?.snappfood ?? null };
}

export async function setOnlinePlatformsConfig(businessId: string, config: OnlinePlatformsConfig): Promise<void> {
  await setSetting(businessId, SETTING_KEYS.onlinePlatforms, config);
}
