/**
 * The cloud side of «اتصال برنامه دسکتاپ»: what an Owner needs in order to
 * connect a desktop install to *their own* business, without going through
 * support.
 *
 * Before this, issuing a pairing code was exclusively a super-admin action.
 * An owner looking for it in their own dashboard found only the server-sync
 * tab's «ساخت توکن», which mints a `POS1-…` token for the already-paired
 * server-to-server channel — a different credential entirely — and pasting it
 * into the desktop's «کد اتصال» box failed as «کد اتصال معتبر نیست». The code
 * generator was in the one place the person who needs it cannot reach.
 *
 * Two facts make a desktop install pair, and this returns both together
 * because handing over one without the other is exactly how the flow failed:
 * the **address** to point the desktop at, and the **code** to redeem there.
 *
 * DB-touching, so no direct unit test per repo convention; the pure pieces it
 * leans on (`connection-code.ts`, `pairing-codes.ts`) have their own.
 */
import {
  issuePairingCode,
  listPairingCodes,
  listPairingLocations,
  revokePairingCode,
  type PairingCodeSummary,
} from "./pairing-service";
import { PAIRING_CODE_TTL_HOURS } from "./pairing-codes";
import { listSiteDevices, type SiteDeviceView } from "./site-device-service";

export { PAIRING_CODE_TTL_HOURS };
export type { PairingCodeSummary };

export interface DesktopLinkView {
  /**
   * The origin to type into the desktop app — **this request's own origin**,
   * never a configured constant.
   *
   * Phase 23's rule ("anything that resolves a tenant before a session exists
   * must ask the host") applies in reverse here: the address that reaches this
   * business is the one the owner is currently signed in at. Deriving it from
   * `PLATFORM_BASE_URL` would hand a multi-tenant deployment's apex to a
   * desktop that needs `biz1.example.com`, which is precisely the "wrong
   * domain" half of the original complaint.
   */
  address: string;
  /** Every code issued for this business, newest first, with its live/spent state. */
  codes: PairingCodeSummary[];
  /** How long a freshly issued code stays redeemable, so the panel can say so. */
  ttlHours: number;
  locations: Array<{ id: string; name: string }>;
  /** Independently revocable site identities created by successful redemptions. */
  devices: SiteDeviceView[];
}

/**
 * The origin of the request being served.
 *
 * `x-forwarded-proto`/`x-forwarded-host` come first where a proxy sets them,
 * falling back to `host` — the same precedence `resolveRequestHost` uses, kept
 * lenient here on purpose: this value is *displayed for a person to copy*, it
 * never decides which tenant a request belongs to, so a spoofed forwarded host
 * costs a wrong string on screen rather than a boundary.
 */
export function originFromHeaders(headers: Headers): string {
  const forwardedHost = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || headers.get("host") || "";
  const declared = headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const proto = declared === "http" || declared === "https" ? declared : "https";
  return host ? `${proto}://${host}` : "";
}

export async function getDesktopLinkView(businessId: string, headers: Headers): Promise<DesktopLinkView> {
  const [codes, locations, devices] = await Promise.all([
    listPairingCodes(businessId),
    listPairingLocations(businessId),
    listSiteDevices(businessId),
  ]);
  return {
    address: originFromHeaders(headers),
    codes,
    locations,
    devices,
    ttlHours: PAIRING_CODE_TTL_HOURS,
  };
}

export type IssueDesktopCodeResult =
  | { ok: true; code: string; address: string; summary: PairingCodeSummary }
  | { ok: false; error: "no_location" | "invalid_location" };

/**
 * Issue a code for this business and return it with the address it is
 * redeemable at, exactly once.
 *
 * Issuing revokes whatever live code the business already had — the schema's
 * partial unique index enforces one-live-per-business — so a second click is
 * a replacement, not an accumulation.
 */
export async function issueDesktopCode(
  businessId: string,
  platformUserId: string | null,
  headers: Headers,
  locationId: string,
): Promise<IssueDesktopCodeResult> {
  const issued = await issuePairingCode(businessId, platformUserId, locationId);
  if ("error" in issued) return { ok: false, error: issued.error };
  return { ok: true, code: issued.code, address: originFromHeaders(headers), summary: issued.summary };
}

export async function revokeDesktopCode(businessId: string, codeId: string): Promise<boolean> {
  return revokePairingCode(businessId, codeId);
}
