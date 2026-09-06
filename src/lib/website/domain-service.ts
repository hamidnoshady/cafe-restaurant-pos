/**
 * Buying a domain for the platform site — the two halves, in one place.
 *
 * The CMS holds the reseller account and places the order; this app takes the
 * money. Neither half knows the other's job, which is the point: the CMS is
 * never told a price in Rial, and this app never speaks to a registrar.
 *
 * The order of operations is the part worth stating, because both orderings
 * fail badly in one direction and only one of them fails recoverably:
 *
 *   1. Price the domain (a quote is free and side-effect-free).
 *   2. Refuse early if the wallet plainly cannot cover it — a business finds
 *      out *before* a registrar order exists, which is the only moment the
 *      answer is still cheap.
 *   3. Place the order with the CMS.
 *   4. Record and settle the charge. If the wallet has drained in between, the
 *      charge is recorded **unsettled** rather than dropped: a domain the
 *      business owns and has not paid for is an invoice, and an invoice is
 *      recoverable. Silently not billing is not.
 *
 * Charging first and ordering second would mean refunding a business whose
 * order the registrar refused, and a refund path that runs on a failure is a
 * path that is never exercised until it matters.
 */
import { cmsDomainQuote, orderCmsDomain } from "../cms/website-service";
import { getWalletBalanceRial } from "../wallet-service";
import { quoteToRial } from "./billing";
import { recordWebsiteCharge, WalletInsufficientFundsError } from "./billing-service";
import { getWebsiteSetup, recordDomainOrder } from "./setup-service";
import { isValidDomain, normalizeDomain } from "./setup";

export type DomainResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface DomainQuote {
  domain: string;
  operation: "register" | "transfer" | "renew";
  period: number;
  /** What the business pays, in integer Rial. */
  priceRial: number | null;
  /** The CMS's own figure and unit, kept so the screen can explain the number. */
  price: number;
  currency: string;
  availability: string;
  availabilityMessage: string;
  resellerEnabled: boolean;
  /** The wallet balance right now, so the screen can offer a top-up before the order. */
  balanceRial: number;
}

export async function quoteWebsiteDomain(
  businessId: string,
  input: { domain: string; operation?: string; period?: number },
): Promise<DomainResult<DomainQuote>> {
  const result = await cmsDomainQuote(businessId, input);
  if (!result.ok) return result;

  const quote = result.data.quote;
  const balanceRial = await getWalletBalanceRial(businessId);
  return {
    ok: true,
    data: {
      domain: normalizeDomain(input.domain),
      operation: quote.operation,
      period: quote.period,
      priceRial: quoteToRial(quote.price, quote.currency),
      price: quote.price,
      currency: quote.currency,
      availability: result.data.availability,
      availabilityMessage: result.data.availabilityMessage,
      resellerEnabled: result.data.resellerEnabled,
      balanceRial,
    },
  };
}

export interface DomainPurchaseInput {
  domain: string;
  operation?: string;
  period?: number;
  nameservers?: string[];
  contact?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  irnicHandles?: Record<string, unknown>;
  eppCode?: string;
}

export interface DomainPurchaseResult {
  domain: string;
  reference: string | null;
  state: string | null;
  chargedRial: number;
  /** True when the order went through but the wallet could not cover it. */
  unpaid: boolean;
}

export async function purchaseWebsiteDomain(
  businessId: string,
  input: DomainPurchaseInput,
  options: { userId?: string | null } = {},
): Promise<DomainResult<DomainPurchaseResult>> {
  const domain = normalizeDomain(input.domain);
  if (!isValidDomain(domain)) return { ok: false, error: "invalid_domain" };

  const quoted = await quoteWebsiteDomain(businessId, { ...input, domain });
  if (!quoted.ok) return quoted;
  if (!quoted.data.resellerEnabled) return { ok: false, error: "registrar_disabled" };

  const priceRial = quoted.data.priceRial;
  // A price this app cannot express in Rial is refused rather than converted
  // at a guessed rate — see `quoteToRial`.
  if (priceRial === null) return { ok: false, error: "unsupported_currency" };
  if (quoted.data.balanceRial < priceRial) return { ok: false, error: "insufficient_credit" };

  const ordered = await orderCmsDomain(businessId, { ...input, domain });
  if (!ordered.ok) return ordered;

  const operation = quoted.data.operation;
  const kind =
    operation === "renew"
      ? "domain_renewal"
      : operation === "transfer"
        ? "domain_transfer"
        : "domain_registration";
  // The registrar's own operation id is the idempotency key when it gives one;
  // otherwise the domain and the period it covers, which is the same fact.
  const reference = ordered.data.reference ?? `${domain}:${operation}:${quoted.data.period}`;

  let unpaid = false;
  try {
    await recordWebsiteCharge({
      businessId,
      kind,
      description: `${kind === "domain_renewal" ? "تمدید" : kind === "domain_transfer" ? "انتقال" : "ثبت"} دامنهٔ ${domain} برای ${quoted.data.period} سال`,
      amountRial: priceRial,
      reference,
      userId: options.userId ?? null,
    });
  } catch (error) {
    if (!(error instanceof WalletInsufficientFundsError)) throw error;
    unpaid = true;
    await recordWebsiteCharge({
      businessId,
      kind,
      description: `${domain} — پرداخت‌نشده (اعتبار کافی نبود)`,
      amountRial: priceRial,
      reference,
      settle: false,
    });
  }

  const setup = await getWebsiteSetup(businessId);
  if (setup.domain === domain || !setup.domain) {
    await recordDomainOrder(businessId, { status: "ordered", reference });
  }

  return { ok: true, data: { domain, reference, state: ordered.data.state, chargedRial: priceRial, unpaid } };
}
