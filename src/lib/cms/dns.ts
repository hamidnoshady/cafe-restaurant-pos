/**
 * Eshobe CMS — domain-arrival checks for the Website Manager's DNS checklist.
 *
 * The CMS's own `/api/domain-check` is Caddy-internal (the Caddyfile answers
 * it 404 on the control plane), so a headless client can't ask "is this
 * domain authorised" from outside. The two facts the builder *can* observe:
 *
 * 1. DNS: does the customer domain resolve, and does it resolve to the same
 *    IPs as the CMS deployment (A/AAAA)? That is the "the record points here"
 *    step, done from the builder's server (same resolver family as the
 *    browsers that will visit the site).
 * 2. Verified: `GET /api/site` (the descriptor) carries `domainVerified` —
 *    the platform-operator's confirmation, the final step of the checklist.
 *
 * These helpers are pure so the comparison logic is unit-testable; the
 * network lookups themselves live in `website-service.ts` (DB/IO-touching,
 * per repo convention not directly unit-tested).
 */

/**
 * True when the copied IP sets overlap — a CNAME chain in front of the CMS
 * (e.g. `acme.ir → cms.eshobe.com`) resolves to the same addresses.
 */
export function ipsOverlap(domainIps: string[], cmsIps: string[]): boolean {
  const domain = new Set(domainIps.map((ip) => ip.toLowerCase()));
  const cms = new Set(cmsIps.map((ip) => ip.toLowerCase()));
  for (const ip of cms) {
    if (domain.has(ip)) return true;
  }
  return false;
}

export interface DnsCheck {
  /**
   * The site's own domain — the host that was looked up. Every message about
   * "your domain" must name *this*, never `cmsHost`: telling an owner that
   * «cms.eshobe.com پاسخ نمی‌دهد» when their acme.ir has no record sends them
   * to the wrong panel.
   */
  domain: string;
  /** The site's domain resolved at all. */
  resolved: boolean;
  /** It resolves to the same server(s) as the CMS itself. */
  pointingToCms: boolean;
  /** The CMS origin's hostname — the CNAME target an owner would point at. */
  cmsHost: string;
  /** Up to a handful of addresses, for display/hints. */
  domainAddresses: string[];
  cmsAddresses: string[];
}

/**
 * Could we even tell where the CMS lives?
 *
 * When the CMS host itself did not resolve — its own DNS is down, the
 * resolver timed out, or the origin is configured as a bare IP literal —
 * `ipsOverlap` is false for a reason that has nothing to do with the
 * customer's records. Saying «رکورد A را تنظیم کنید» there sends an owner to
 * change a setting that is already correct, so this case is named instead.
 */
export function cmsTargetUnknown(check: DnsCheck): boolean {
  return check.cmsAddresses.length === 0;
}

/**
 * The domain resolves somewhere other than the CMS — the one case where the
 * owner really does have a record to fix.
 */
export function pointsElsewhere(check: DnsCheck): boolean {
  return check.resolved && !check.pointingToCms && !cmsTargetUnknown(check);
}

/** Human hint, in the caller's language. Persian here — the app is Persian-first. */
export function dnsHint(check: DnsCheck): string {
  if (!check.resolved) {
    return `«${check.domain}» پاسخ نمی‌دهد یا هنوز رکورد DNS ندارد — در پنل ثبت‌کنندهٔ دامنه رکورد A یا CNAME را بسازید و منتظر انتشار DNS بمانید.`;
  }
  if (cmsTargetUnknown(check)) {
    // Not the owner's problem, and not a reason to send them to their
    // registrar: we could not resolve our own server's address this time.
    return `«${check.domain}» پاسخ می‌دهد، اما آدرس سرور CMS («${check.cmsHost}») این بار خوانده نشد؛ کمی بعد دوباره «بررسی DNS» را بزنید.`;
  }
  if (!check.pointingToCms) {
    return `«${check.domain}» به سرور CMS اشاره نمی‌کند. رکورد A را روی ${check.cmsAddresses.slice(0, 3).join("، ")} — یا CNAME را روی ${check.cmsHost} — تنظیم کنید. اگر دامنه پشت CDN است، همین رکوردها باید در پنل CDN ثبت شوند.`;
  }
  return "DNS به سرور CMS اشاره می‌کند. برای فعال‌شدن کامل، در پنل CMS تأیید دامنه را روشن کنید.";
}

/**
 * One-line Persian guidance for the Website Manager's checklist card.
 *
 * Lives in this pure module rather than `website-service.ts` because the
 * dashboard's client component renders it — a client bundle cannot follow an
 * import into the DB-backed service (it would drag `pg` into the browser).
 * The shape is structural, so the service's richer status object satisfies it
 * without this module ever importing from that one.
 */
export function cmsDnsHint(status: {
  dns: DnsCheck;
  domainVerified: boolean | null;
}): string {
  if (!status.dns.resolved) return dnsHint(status.dns);
  if (!status.dns.pointingToCms) return dnsHint(status.dns);
  // `null` is "the descriptor could not be read", which is a different
  // sentence from "the operator has not ticked the box yet" — the first is
  // ours to fix and the second is theirs.
  if (status.domainVerified === null) {
    return "DNS درست است، اما وضعیت «تأیید دامنه» از سایت‌ساز خوانده نشد؛ کمی بعد دوباره بررسی کنید.";
  }
  if (!status.domainVerified) return dnsHint(status.dns);
  return "دامنه به سرور CMS اشاره می‌کند و در پنل تأیید شده است — سایت روی اینترنت فعال است.";
}

/**
 * Is the site actually being served on its own domain?
 *
 * The in-app preview loads the real site over the real domain, so it can only
 * work once all three checklist steps are true. One definition, used by the
 * card that renders the steps and by the card that decides whether to embed
 * the frame — two spellings of "live" is how they end up disagreeing.
 */
export function isSiteLive(status: { dns: DnsCheck; domainVerified: boolean | null }): boolean {
  return status.dns.resolved && status.dns.pointingToCms && status.domainVerified === true;
}
