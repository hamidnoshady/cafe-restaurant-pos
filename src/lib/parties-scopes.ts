/**
 * Party scopes — how one shared record looks different in each app.
 *
 * The rule this encodes: **the data is one thing, the screens are many.** Every
 * app that lists «اشخاص» mounts the same section component over the same
 * `/api/parties` endpoint and the same `parties` table; what differs is which
 * roles it shows, which columns it draws, and what it lets you edit there. A
 * café owner opening the CRM sees customers and their phones; the same person
 * opening Accounting sees the whole file including the ledger number; the store
 * clerk opening Inventory sees suppliers; the Team tab sees personnel; Growth
 * sees the same customers with lifecycle and loyalty columns.
 *
 * Why a table of scopes rather than four hand-written sections: the moment the
 * per-app views are four copies, one of them drifts — a column appears in
 * Accounting and never in the CRM, or the inventory view starts editing tax rates
 * the ledger owns. `PARTY_SCOPES` is the one place that answers "what does this
 * app show", and `parties-scopes.test.ts` is what keeps it answering for every
 * app in `apps.ts`.
 *
 * Framework-free, like `apps.ts` itself.
 */
import type { AppKey } from "./apps";
import { PARTY_ROLE_LABELS, type PartyRole } from "./parties";

export const PARTY_SCOPES = [
  "crm",
  "accounting",
  // Accounting's customers-only screen. It reads the same one record as the
  // full «اشخاص» view, but answers the accountant's customer question
  // (who a customer is in the ledger) without the suppliers and staff noise.
  "accounting-customers",
  "operations",
  "team",
  "growth",
  "sales",
] as const;
export type PartyScope = (typeof PARTY_SCOPES)[number];

/** A column the list can draw. Which ones are drawn is the scope's business. */
export const PARTY_COLUMNS = [
  "displayName",
  "role",
  "phone",
  "email",
  "city",
  "category",
  "accountingCode",
  "tax",
  "balance",
  "status",
] as const;
export type PartyColumn = (typeof PARTY_COLUMNS)[number];

export const PARTY_COLUMN_LABELS: Record<PartyColumn, string> = {
  displayName: "نام",
  role: "نقش",
  phone: "تلفن",
  email: "پست الکترونیکی",
  city: "شهر",
  category: "دسته",
  accountingCode: "کد حسابداری",
  tax: "نرخ مالیات",
  // The receivable, read from the ledger's own endpoint — a column the CRM has
  // always shown, and the one number here that is *not* stored on the party.
  balance: "مانده حساب",
  status: "وضعیت",
};

export interface PartyScopeDef {
  key: PartyScope;
  /** The app whose shell hosts this view (`src/lib/apps.ts`). */
  app: AppKey;
  /** The roles this app lists — the `WHERE role = ANY(...)` of the section. */
  roles: PartyRole[];
  /** The role preselected when this app creates a party. */
  defaultRole: PartyRole;
  /** The nav label this app gives the section. */
  label: string;
  description: string;
  /** Where the section lives. */
  href: string;
  columns: PartyColumn[];
  /**
   * Whether this app may change the money-adjacent fields (accounting code, tax
   * rate, bank details). `readonly` shows them without inputs; `hidden` omits
   * them — a cashier picking a customer has no use for a ledger number.
   */
  accounting: "editable" | "readonly" | "hidden";
  /**
   * A read-only scope is a *view*: it lists the shared record and links to the
   * app that owns it, as the sales picker scope does. Every real app screen is
   * editable — the record stays one thing because every one of them writes
   * through the same form and the same endpoint, not because only one app may
   * write.
   */
  readOnly: boolean;
}

export const PARTY_SCOPES_DEF: readonly PartyScopeDef[] = [
  {
    key: "crm",
    app: "crm",
    roles: ["Customer"],
    defaultRole: "Customer",
    label: "مشتریان",
    description: "پروندهٔ مشتریان: افزودن، ویرایش و بایگانی",
    href: "/dashboard/crm/directory",
    columns: ["displayName", "phone", "email", "accountingCode", "balance", "status"],
    // The CRM owns who the person is; the ledger owns their number. The code and the
    // balance are shown because an AR conversation needs them, and never edited
    // because it never does.
    accounting: "readonly",
    readOnly: false,
  },
  {
    key: "accounting",
    app: "accounting",
    // Every counterparty, because the ledger is the one app that settles with all
    // three: AR against customers, AP against suppliers, payroll against staff.
    // This is Accounting's own «اشخاص» — managed here, never by sending the
    // accountant into the CRM's customers screen.
    roles: ["Customer", "Employee", "Supplier"],
    defaultRole: "Customer",
    label: "اشخاص",
    description: "مشتریان، تأمین‌کنندگان و کارکنان با کد حسابداری و اطلاعات مالی",
    // The Accounting app has its own route prefix now (`/dashboard/accounting`),
    // one route per section — this is its persons directory, and the `?party=`
    // a deep link from another app (an A/R row, an AI answer) carries is read
    // by the section it opens.
    href: "/dashboard/accounting/directory",
    columns: ["displayName", "role", "phone", "accountingCode", "tax", "status"],
    accounting: "editable",
    readOnly: false,
  },
  {
    // Accounting's customers-only view. The full counterparty screen above is
    // the ledger's whole file; this is the one the customer links in A/R open —
    // so an accountant looking at a receivable lands on customers, with the
    // ledger fields that make that record settleable, and never behind Growth's
    // marketing projection. The record remains CRM's; this is Accounting's view
    // of it, and the shared `PartiesSection` draws it with these columns.
    key: "accounting-customers",
    app: "accounting",
    roles: ["Customer"],
    defaultRole: "Customer",
    label: "مشتریان",
    description: "مشتریان با کد حسابداری، مالیات و ماندهٔ حساب",
    href: "/dashboard/accounting/customers",
    columns: ["displayName", "phone", "accountingCode", "tax", "balance", "status"],
    accounting: "editable",
    readOnly: false,
  },
  {
    key: "operations",
    app: "operations",
    roles: ["Supplier"],
    defaultRole: "Supplier",
    label: "تأمین‌کنندگان",
    description: "پروندهٔ تأمین‌کنندگان انبار و خرید",
    href: "/dashboard/inventory?tab=suppliers",
    columns: ["displayName", "phone", "city", "accountingCode", "status"],
    accounting: "readonly",
    readOnly: false,
  },
  {
    key: "team",
    app: "settings",
    roles: ["Employee"],
    defaultRole: "Employee",
    label: "کارکنان",
    description: "پروندهٔ کارکنان — حساب جاری، کد ملی و اطلاعات مالی",
    href: "/dashboard/settings?tab=team",
    columns: ["displayName", "phone", "accountingCode", "status"],
    accounting: "readonly",
    readOnly: false,
  },
  {
    key: "growth",
    app: "growth",
    roles: ["Customer"],
    defaultRole: "Customer",
    label: "مشتریان",
    description: "مشتریان رشد: چرخهٔ حیات، امتیاز و خرید — افزودن و ویرایش در همین بخش",
    href: "/dashboard/growth/customers",
    columns: ["displayName", "phone", "status"],
    accounting: "hidden",
    // Growth manages its own customers screen (its own lifecycle/loyalty columns,
    // its own add/edit form) over the same shared `parties` row — the record is
    // still one thing, so there is no second table for the duplicates screen to
    // clean up. Only the 360° file (notes, tags, timeline) stays CRM's.
    readOnly: false,
  },
  {
    key: "sales",
    app: "sales",
    roles: ["Customer"],
    defaultRole: "Customer",
    label: "مشتریان",
    description: "انتخاب مشتری برای فاکتور — ویرایش در CRM",
    href: "/dashboard/orders",
    columns: ["displayName", "phone"],
    accounting: "hidden",
    readOnly: true,
  },
];

/** Look up a scope by key. An unknown key is the CRM view: the safest, narrowest one. */
export function partyScopeFor(key: string | null | undefined): PartyScopeDef {
  const found = PARTY_SCOPES_DEF.find((def) => def.key === key);
  return found ?? PARTY_SCOPES_DEF[0];
}

/** The scope an app mounts. `null` for the apps that have no party view at all. */
export function partyScopeForApp(app: AppKey): PartyScopeDef | null {
  return PARTY_SCOPES_DEF.find((def) => def.app === app) ?? null;
}

/** Which role a new party gets in this app — the part that makes the section feel native. */
export function defaultRoleForScope(scope: PartyScopeDef): PartyRole {
  return scope.defaultRole;
}

/** The label a row's role gets inside a scope («مشتری» is noise in the CRM's own list). */
export function roleLabelInScope(scope: PartyScopeDef, role: PartyRole): string | null {
  return scope.roles.length > 1 ? PARTY_ROLE_LABELS[role] : null;
}

export function showsColumn(scope: PartyScopeDef, column: PartyColumn): boolean {
  return scope.columns.includes(column);
}

/** Whether this app may edit the accounting tab at all. */
export function canEditAccountingInScope(scope: PartyScopeDef): boolean {
  return !scope.readOnly && scope.accounting === "editable";
}

/** Whether the accounting fields are visible (read-only counts as visible). */
export function canSeeAccountingInScope(scope: PartyScopeDef): boolean {
  return scope.accounting !== "hidden";
}

/**
 * Client-side filter for the shared lists a section reads for other reasons (the
 * AR balance map, a picker that already has the rows). The server filters too —
 * this is not the boundary, it is one less re-render.
 */
export function partyMatchesScope(scope: PartyScopeDef, role: PartyRole | string | null | undefined): boolean {
  return scope.roles.includes(role as PartyRole);
}

/**
 * The app that *owns* a role's record — the place a read-only view links to.
 *
 * This is the one-screen-per-role half of the rule: an app may list a party it
 * consumes, but the edit affordance always lands on the scope whose business the
 * role is. Customers are CRM's, suppliers the store's, personnel the team's.
 */
export function partyOwnerScopeForRole(role: PartyRole): PartyScopeDef {
  const owner = PARTY_SCOPES_DEF.find(
    (def) => !def.readOnly && def.key !== "accounting" && def.roles.includes(role),
  );
  // Accounting is the fallback for a role nobody else claims, and every role is
  // claimed, so this only fires if a scope is deleted by mistake.
  return owner ?? partyScopeFor("accounting");
}

/**
 * Where a row's canonical record is edited, from the point of view of a scope that
 * cannot edit it. The read-only views are only honest if the link is there.
 */
export function partyEditHrefForScope(scope: PartyScopeDef, role: PartyRole | null | undefined): string {
  if (!scope.readOnly) return scope.href;
  return partyOwnerScopeForRole((role ?? "Customer") as PartyRole).href;
}
