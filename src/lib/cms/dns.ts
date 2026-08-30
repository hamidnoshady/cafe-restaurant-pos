/**
 * Eshobe CMS — domain-arrival checks for the Website Manager's DNS checklist.
 *
 * The CMS's own `/api/domain-check` is Caddy-internal (the Caddyfile answers
 * it 404 on the control plane), so a headless client can't ask "is this
 * domain authorised" from outside. The two facts the builder *can* observe:
 *
 * 1. DNS: does the customer domain resolve to the same IPs as the CMS
 *    deployment (A/AAAA)? That is the "the record points here" step, done
 *    from the builder's server (same resolver family as the browsers that
 *    will visit the site).
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
  /** The site's domain resolved at all. */
  resolved: boolean;
  /** It resolves to the same server(s) as the CMS itself. */
  pointingToCms: boolean;
  /** The host we asked the resolver for (the CMS origin's hostname). */
  cmsHost: string;
  /** Up to a handful of addresses, for display/hints. */
  domainAddresses: string[];
  cmsAddresses: string[];
}

/** Human hint, in the caller's language. Persian here — the app is Persian-first. */
export function dnsHint(check: DnsCheck): string {
  if (!check.resolved) {
    return `«${check.cmsHost}» پاسخ نمی‌دهد یا سابقهٔ DNS ندارد — ابتدا رکورد A/CNAME را بسازید و منتظر انتشار DNS بمانید.`;
  }
  if (!check.pointingToCms) {
    return `DNS به سرور CMS اشاره نمی‌کند. رکورد A به آدرس ${check.cmsAddresses.slice(0, 3).join("، ") || check.cmsHost} — یا CNAME به ${check.cmsHost} — تنظیم کنید.`;
  }
  return "DNS به سرور CMS اشاره می‌کند. برای فعال‌شدن کامل، در پنل CMS تأیید دامنه را روشن کنید.";
}
