/**
 * The one people directory, and the views it offers.
 *
 * «اشخاص» used to be four screens with four sidebar entries — «اشخاص»،
 * «مشتریان»، «تأمین‌کنندگان»، «فروشندگان» — each a `PartyScopeDef` of its own,
 * each its own route, all four over the same `parties` table and the same
 * `/api/parties` endpoint. Four doors into one room is how a menu grows
 * twenty rows and how a person ends up entered twice, once through each door.
 *
 * So there is one directory (`/accounting/directory`) and the four words are
 * *views* of it: a `?view=` filter over the same list, the same columns and
 * the same add/edit form. A deep link from A/R, from purchases or from the CRM
 * opens the directory with the right view already selected rather than opening
 * a screen of its own.
 *
 * Framework-free (no React, no `next`, no `db`) like `parties-scopes.ts` beside
 * it, so the server-rendered page, the client list and the unit tests all read
 * the same table.
 */
import { PARTY_ROLES, type PartyRole } from "./parties";

export const PARTY_DIRECTORY_VIEW_KEYS = [
  "all",
  "customers",
  "suppliers",
  // «فروشندگان» is the same `parties` row as «تأمین‌کنندگان» under the word an
  // accountant coming from another package looks for. It is a view, never a
  // second store — the note migration 0137 and `parties-scopes.ts` both make.
  "vendors",
  "employees",
] as const;
export type PartyDirectoryViewKey = (typeof PARTY_DIRECTORY_VIEW_KEYS)[number];

export interface PartyDirectoryView {
  key: PartyDirectoryViewKey;
  label: string;
  /** One line under the label, and the empty state's explanation. */
  description: string;
  /**
   * The roles this view lists. Since migration 0148 a party holds a *set* of
   * roles, so these are matched by overlap: one person who is both a customer
   * and a supplier is in both views, as one record with one balance.
   */
  roles: readonly PartyRole[];
  /** The role a new person created from this view starts with ticked. */
  defaultRoles: readonly PartyRole[];
}

export const PARTY_DIRECTORY_VIEWS: readonly PartyDirectoryView[] = [
  {
    key: "all",
    label: "همه اشخاص",
    description: "همهٔ طرف‌حساب‌ها — مشتری، تأمین‌کننده و کارکنان، در یک فهرست",
    roles: PARTY_ROLES,
    defaultRoles: ["Customer"],
  },
  {
    key: "customers",
    label: "مشتریان",
    description: "کسانی که به آن‌ها می‌فروشید",
    roles: ["Customer"],
    defaultRoles: ["Customer"],
  },
  {
    key: "suppliers",
    label: "تأمین‌کنندگان",
    description: "کسانی که از آن‌ها می‌خرید",
    roles: ["Supplier"],
    defaultRoles: ["Supplier"],
  },
  {
    key: "vendors",
    label: "فروشندگان",
    description: "همان پروندهٔ تأمین‌کنندگان، با واژهٔ «فروشنده»",
    roles: ["Supplier"],
    defaultRoles: ["Supplier"],
  },
  {
    key: "employees",
    label: "کارکنان",
    description: "پروندهٔ کارکنان — حساب جاری و اطلاعات مالی",
    roles: ["Employee"],
    defaultRoles: ["Employee"],
  },
];

/**
 * The views worth a nav entry of their own.
 *
 * «همه اشخاص» is the directory itself, so it is not repeated; «کارکنان» is
 * reached from «مدیریت تیم», which is where a business looks for staff. What
 * is left is the two words every app deep-links with.
 */
export const PARTY_DIRECTORY_NAV_VIEWS = PARTY_DIRECTORY_VIEWS.filter(
  (view) => view.key === "customers" || view.key === "suppliers",
);

/** The directory's one canonical address. Every «اشخاص» link in the product points here. */
export const PARTY_DIRECTORY_HREF = "/accounting/directory";

export function isPartyDirectoryViewKey(value: unknown): value is PartyDirectoryViewKey {
  return typeof value === "string" && (PARTY_DIRECTORY_VIEW_KEYS as readonly string[]).includes(value);
}

/** A view by key. An unknown or missing key is «همه اشخاص» — the whole directory. */
export function partyDirectoryView(key: string | null | undefined): PartyDirectoryView {
  return PARTY_DIRECTORY_VIEWS.find((view) => view.key === key) ?? PARTY_DIRECTORY_VIEWS[0];
}

/**
 * The directory's URL for a view, optionally with one party's file open.
 *
 * «همه اشخاص» is the bare address: the default view does not need to be spelled
 * out in a URL, and a link that says `?view=all` would make the same screen have
 * two addresses.
 */
export function partyDirectoryHref(
  view: PartyDirectoryViewKey | null | undefined = "all",
  options: { party?: string | null } = {},
): string {
  const params = new URLSearchParams();
  if (view && view !== "all") params.set("view", view);
  if (options.party) params.set("party", options.party);
  const query = params.toString();
  return query ? `${PARTY_DIRECTORY_HREF}?${query}` : PARTY_DIRECTORY_HREF;
}

/**
 * The view another app should deep-link into when it is talking about a role.
 *
 * A/R opens customers, A/P and purchasing open suppliers, payroll and the team
 * open personnel — all of them the same directory, so nobody bounces between
 * apps to edit one phone number.
 */
export function partyDirectoryViewForRole(role: PartyRole): PartyDirectoryViewKey {
  switch (role) {
    case "Supplier":
      return "suppliers";
    case "Employee":
      return "employees";
    default:
      return "customers";
  }
}

/** A category row as the directory's *filter* needs to see it. */
export interface PartyCategoryFilterRow {
  id: string;
  /** The role a category is scoped to, or null for «every role». */
  role: string | null;
  isActive: boolean;
}

/**
 * The categories the directory offers as filters: active ones whose role (when
 * they have one) is among the roles being listed.
 *
 * The manage dialog shows everything including the archived — it edits the
 * reference list — but a *filter* that offers «بایگانی‌شده» or a personnel-only
 * grouping while the list shows customers is a control that answers with
 * nothing. This is the one definition of that rule, so the section that draws
 * the select and the effect that retires a stale selection cannot disagree.
 */
export function directoryFilterCategories<T extends PartyCategoryFilterRow>(
  categories: readonly T[],
  listedRoles: readonly PartyRole[],
): T[] {
  return categories.filter(
    (category) =>
      category.isActive &&
      (!category.role || listedRoles.includes(category.role as PartyRole)),
  );
}
