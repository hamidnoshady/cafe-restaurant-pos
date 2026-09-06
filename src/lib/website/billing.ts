/**
 * What a platform website costs, and when the next payment falls due.
 *
 * «سایت‌ساز کار سایت را می‌کند؛ پول را این‌جا می‌گیریم.» The CMS renders and
 * serves the site; it has no idea what a business owes, has no wallet and
 * sends no invoice. Every Rial — the monthly site fee, a domain bought through
 * the platform's registrar, a renewal, a one-off setup — is decided here and
 * settled against the platform wallet the business already tops up
 * (migration 0130), so a website bill and an AI-credit bill come out of one
 * balance and one payment page.
 *
 * Framework-free and DB-free: the arithmetic (what a period costs, when it
 * ends, what a quote in another currency is worth in Rial) is the part worth
 * pinning in a unit test and must read the same in the billing section, in
 * the wizard's price line and in the renewal tick. The DB half is
 * `billing-service.ts`.
 *
 * Money is **integer Rial** here, as everywhere in this repo. The CMS quotes
 * a domain in the platform's own currency setting (Toman by default), so
 * conversion happens exactly once, on the way in, in `quoteToRial`.
 */

export const WEBSITE_CHARGE_KINDS = [
  "setup",
  "subscription",
  "domain_registration",
  "domain_renewal",
  "domain_transfer",
  "cdn",
  "adjustment",
] as const;
export type WebsiteChargeKind = (typeof WEBSITE_CHARGE_KINDS)[number];

export const WEBSITE_CHARGE_LABELS: Record<WebsiteChargeKind, string> = {
  setup: "راه‌اندازی سایت",
  subscription: "اشتراک ماهانهٔ سایت",
  domain_registration: "ثبت دامنه",
  domain_renewal: "تمدید دامنه",
  domain_transfer: "انتقال دامنه",
  cdn: "سرویس CDN",
  adjustment: "اصلاح صورت‌حساب",
};

export const WEBSITE_SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "cancelled"] as const;
export type WebsiteSubscriptionStatus = (typeof WEBSITE_SUBSCRIPTION_STATUSES)[number];

export const WEBSITE_SUBSCRIPTION_STATUS_LABELS: Record<WebsiteSubscriptionStatus, string> = {
  trialing: "دورهٔ آزمایشی",
  active: "فعال",
  past_due: "پرداخت‌نشده",
  cancelled: "لغو شده",
};

export interface WebsitePlan {
  key: string;
  name: string;
  description: string | null;
  monthlyPriceRial: number;
  setupPriceRial: number;
  /** Empty means "usable for every site type". */
  siteTypes: string[];
  includesCdn: boolean;
  includesDomain: boolean;
  maxProducts: number | null;
  maxPages: number | null;
  isActive: boolean;
  sortOrder: number;
}

export interface WebsiteSubscription {
  planKey: string;
  status: WebsiteSubscriptionStatus;
  startedAt: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  autoRenew: boolean;
  cancelledAt: string | null;
  monthlyPriceRial: number;
}

export interface WebsiteCharge {
  id: string;
  kind: WebsiteChargeKind;
  description: string;
  amountRial: number;
  occurredAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  reference: string;
}

/** The plans a site of this type may be put on. An empty `siteTypes` fits every type. */
export function plansForSiteType(plans: WebsitePlan[], siteType: string): WebsitePlan[] {
  return plans
    .filter((plan) => plan.isActive)
    .filter((plan) => plan.siteTypes.length === 0 || plan.siteTypes.includes(siteType))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
}

/**
 * One month on from `iso`, clamped to the end of the target month.
 *
 * The 31st of a month has no counterpart in the next one, and rolling over
 * into the month after (which `setMonth` does on its own) would quietly move a
 * business's billing date forward for good. Clamping to the 28th/30th keeps
 * the anniversary stable.
 *
 * Gregorian arithmetic on a `timestamptz`, as every stored date in this repo
 * is; the *display* of these dates is Shamsi, through `src/lib/jalali.ts`.
 */
export function addMonths(iso: string, months: number): string {
  const from = new Date(iso);
  if (Number.isNaN(from.getTime())) throw new Error("bad_date");
  const day = from.getUTCDate();
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1));
  const daysInTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTarget));
  target.setUTCHours(from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds());
  return target.toISOString();
}

/**
 * The idempotency key for a period's subscription charge.
 *
 * Built from the period the charge covers, never from the moment the tick ran:
 * a retry, a second replica or an operator re-running the renewal must land on
 * the same key and be refused by the UNIQUE index rather than billing twice.
 * The same rule `notificationDedupeKey` follows, for the same reason.
 */
export function subscriptionReference(periodStartIso: string): string {
  const start = new Date(periodStartIso);
  if (Number.isNaN(start.getTime())) throw new Error("bad_date");
  const month = `${start.getUTCMonth() + 1}`.padStart(2, "0");
  return `period:${start.getUTCFullYear()}-${month}-${`${start.getUTCDate()}`.padStart(2, "0")}`;
}

/** Is this subscription's period over, so the next one should be billed? */
export function isRenewalDue(subscription: WebsiteSubscription, nowIso: string): boolean {
  if (!subscription.autoRenew) return false;
  if (subscription.status === "cancelled") return false;
  return new Date(subscription.currentPeriodEnd).getTime() <= new Date(nowIso).getTime();
}

/** What the business owes for the next period of this subscription. */
export function renewalAmountRial(subscription: WebsiteSubscription): number {
  return Math.max(0, Math.floor(subscription.monthlyPriceRial));
}

/**
 * A registrar quote, in Rial.
 *
 * The CMS prices a domain in the platform's configured currency; this app
 * keeps money in integer Rial. `IRT` (Toman) is ten Rial — the one place that
 * factor appears on this side, exactly as `src/lib/money.ts` keeps it on the
 * CMS side. A quote in a foreign currency is *refused* rather than converted
 * at a guessed rate: charging a business a number nobody can reconcile is
 * worse than telling them the platform cannot sell them that TLD yet.
 */
export function quoteToRial(price: number, currency: string): number | null {
  if (!Number.isFinite(price) || price < 0) return null;
  const amount = Math.round(price);
  if (currency === "IRR") return amount;
  if (currency === "IRT") return amount * 10;
  return null;
}

/** The sum of a list of charges, in Rial. */
export function totalChargedRial(charges: WebsiteCharge[]): number {
  return charges.reduce((sum, charge) => sum + Math.max(0, Math.floor(charge.amountRial)), 0);
}
