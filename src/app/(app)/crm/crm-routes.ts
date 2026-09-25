/**
 * The CRM app's section routing (Phase 36).
 *
 * Same shape as `growth-routes.ts`, and deliberately so: these keys are the one
 * source of truth for the app's menu (`crm-nav.ts` labels them), for the
 * server-side role gate on each page, and for the sidebar's "you are here".
 * A section that exists as a route but not as a key is a page nobody can find.
 *
 * The role line is drawn differently from Growth's, because the data is
 * different. Growth gates on *compensation*; the CRM gates on **who the
 * customer is**:
 *
 * - `directory`, `persons` (the 360° file) and `activities` are floor work —
 *   a cashier takes a phone number, adds a note, ticks off a callback. They are
 *   the surfaces the old flat «مشتریان» page already gave them.
 * - `cases` is floor work too: the person who hears the complaint is the person
 *   at the counter, and a service desk a cashier cannot open is a service desk
 *   that never gets used.
 * - `leads` is management: an unconverted enquiry carries a revenue
 *   expectation and an owner, and converting one creates a customer record.
 * - `overview`, `segments`, `deals`, `duplicates` and `consent` are management.
 *   Segments and consent decide who gets *messaged*, duplicates *destroys*
 *   records irreversibly, deals carry revenue expectations, and the overview
 *   aggregates all of it — none of that belongs to a shift.
 *
 * Accountants are admitted read-only to nothing here: the CRM holds no ledger
 * data of its own (deals post nothing — see migration 0118), so there is no
 * accounting reason to be in it, and personal customer data with no reason to
 * be read is data that should not be reachable.
 */

import { PERMISSIONS, type Permission } from "@/lib/permissions";

export const CRM_SECTION_KEYS = [
  "overview",
  "directory",
  "persons",
  "leads",
  "segments",
  "deals",
  "activities",
  "cases",
  "duplicates",
  // Deciding who an anonymous online shopper is attaches their whole purchase
  // history to a named person, so it sits with the management sections rather
  // than on the floor.
  "reconciliation",
  "consent",
  // The CRM's *own* settings. `/settings` is the platform settings area;
  // `/crm/settings` configures this app (duplicate matching, consent defaults,
  // pipeline stages) and is a different route with a different component.
  "settings",
] as const;

export type CrmSectionKey = (typeof CRM_SECTION_KEYS)[number];

/** The route for a section. The overview is the app root; the rest nest under it. */
export function crmSectionHref(key: CrmSectionKey): string {
  return key === "overview" ? "/crm/overview" : `/crm/${key}`;
}

/** The CRM's own settings page — never the platform settings page. */
export const CRM_SETTINGS_HREF = "/crm/settings";

/** The route of one customer's 360° file. */
export function crmCustomerHref(customerId: string): string {
  return `/crm/persons/${customerId}`;
}

/**
 * Where a won deal's settled sale actually lives. The orders screen opens a
 * given order straight away on `?order=<id>` (see `accounting/orders/page.tsx`
 * and `OrdersList`'s `initialOrderId`) — this is the one other place in the
 * app a deal's `orderId` is allowed to point, since the pipeline itself posts
 * nothing.
 */
export function crmDealOrderHref(orderId: string): string {
  return `/accounting/orders?order=${orderId}`;
}

/**
 * The capability each section needs — the same key its API enforces.
 *
 * This replaces a role test (`role === "cashier" ? floorSections : ["owner",
 * "manager"].includes(role)`) that asked a different question from the routes
 * behind it. The CRM's APIs are gated on `crm.*` and `parties.*` keys, so a
 * member granted `crm.view` individually got a working API behind an invisible
 * menu, and a manager who had `crm.consent_manage` revoked still saw the
 * consent screen with every write on it failing.
 *
 * The mapping preserves the previous audience exactly for the built-in
 * presets. `crm.manage` is the floor's share (the cashier preset carries it,
 * which is what the old `CASHIER_SECTIONS` list encoded), `crm.view` is the
 * management share, and the two structural screens keep their own keys.
 */
const SECTION_PERMISSION: Record<CrmSectionKey, Permission> = {
  // The floor's share: logging that a customer called is counter work.
  directory: PERMISSIONS.crmManage,
  persons: PERMISSIONS.crmManage,
  activities: PERMISSIONS.crmManage,
  cases: PERMISSIONS.crmManage,
  // The management share: the 360° analysis, the pipeline, the segments.
  overview: PERMISSIONS.crmView,
  leads: PERMISSIONS.crmView,
  segments: PERMISSIONS.crmView,
  deals: PERMISSIONS.crmView,
  duplicates: PERMISSIONS.crmView,
  reconciliation: PERMISSIONS.crmView,
  // Consent is a control, not a screen: the same key `POST /api/crm/consent`
  // enforces.
  consent: PERMISSIONS.crmConsentManage,
  // Structural: a stage rename reshapes every historical report built on it.
  settings: PERMISSIONS.crmConfigure,
};

/** The capability a section needs, for callers that want to state it themselves. */
export function crmSectionPermission(key: CrmSectionKey): Permission {
  return SECTION_PERMISSION[key];
}

/** Whether a member's effective permissions admit them to a section. */
export function canViewCrmSection(permissions: ReadonlySet<string>, key: CrmSectionKey): boolean {
  return permissions.has(SECTION_PERMISSION[key]);
}

/** Whether a member has at least one CRM surface — the layout's gate. */
export function canOpenCrm(permissions: ReadonlySet<string>): boolean {
  return CRM_SECTION_KEYS.some((key) => canViewCrmSection(permissions, key));
}

/**
 * Where to send someone who lands on a section they may not open. A cashier
 * following a bookmark to the pipeline gets the directory rather than being
 * thrown out of the app entirely — being bounced to `/dashboard` from a page
 * you were linked to reads as a bug, not as a permission.
 */
export function crmFallbackHref(permissions: ReadonlySet<string>): string {
  const first = CRM_SECTION_KEYS.find((key) => canViewCrmSection(permissions, key));
  // Prefer the directory when they have it — it is the app's front door — and
  // otherwise the first surface they can actually open, so that someone with
  // only, say, the consent screen still lands inside the app rather than being
  // bounced out of it.
  if (canViewCrmSection(permissions, "directory")) return crmSectionHref("directory");
  return first ? crmSectionHref(first) : "/dashboard";
}

/**
 * Whether a dashboard path is a given section — the sidebar's idea of "you are
 * here". The overview is the app root, so it matches exactly and nothing else;
 * every other section also owns what nests under it. A customer's file
 * (`/crm/persons/<id>`) belongs to Contacts (`directory`) for navigation, not
 * to a permanent detail-page sidebar entry.
 *
 * The old `customers` path is kept as an alias for `persons` so bookmarks and
 * external links survive the rename — both the current `/crm/customers/*` and
 * the pre-move `/dashboard/crm/customers/*`, which middleware redirects here.
 */
export function isCrmSectionPathname(pathname: string, key: CrmSectionKey): boolean {
  const href = crmSectionHref(key);
  if (key === "overview") return pathname === href;
  const isPersonDetail =
    pathname === "/crm/persons" ||
    pathname.startsWith("/crm/persons/") ||
    pathname === "/crm/customers" ||
    pathname.startsWith("/crm/customers/");
  // A person file is reached from Contacts; it is not a second permanent
  // sidebar destination. Keep the owning Contacts row current on both the
  // canonical and compatibility detail URLs.
  if (key === "directory") {
    return pathname === href || pathname.startsWith(`${href}/`) || isPersonDetail;
  }
  if (key === "persons") return isPersonDetail;
  return pathname === href || pathname.startsWith(`${href}/`);
}
