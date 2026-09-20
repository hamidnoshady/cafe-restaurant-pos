/**
 * Phase 12 — permissions.
 *
 * The decision was "system-role presets plus per-member overrides", not a
 * role builder: a business picks a role for each member and then grants or
 * revokes individual capabilities on top of it. That keeps the common case
 * (a cashier is a cashier) free of configuration while still allowing "this
 * manager may also post journal entries".
 *
 * Framework-free and side-effect-free by design — this is the file that
 * decides who may do what, so it is unit-tested directly (permissions.test.ts)
 * rather than only through route handlers.
 */
import type { Role } from "./auth";

/**
 * Every capability the system recognises. Coarse enough to stay manageable in
 * a UI (Phase 13 renders these as checkboxes), fine enough that the accounting
 * surfaces Phase 16 adds can be delegated without handing over the whole
 * business.
 */
export const PERMISSIONS = {
  // Point of sale
  ordersCreate: "orders.create",
  ordersVoid: "orders.void",
  /**
   * Editing or removing an order that has already been paid for. Deliberately
   * separate from `orders.void`, which only reaches an *open* order nobody has
   * settled: this one reverses posted revenue, VAT, COGS and stock, so it is a
   * back-office privilege rather than a till one.
   */
  ordersAmendClosed: "orders.amend_closed",
  /**
   * Recording a sale that already happened — the evening the POS was down, the
   * week before the install. Separate from `orders.create` because it writes
   * revenue, VAT, COGS and stock into a day that is already reported on, which
   * is a back-office act rather than a till one.
   */
  ordersBackdate: "orders.backdate",
  ordersDiscount: "orders.discount",
  paymentsTake: "payments.take",
  paymentsRefund: "payments.refund",

  // Floor
  tablesManage: "tables.manage",
  reservationsManage: "reservations.manage",
  kitchenView: "kitchen.view",
  deliveryManage: "delivery.manage",

  // Catalogue
  menuView: "menu.view",
  menuEdit: "menu.edit",

  // Inventory
  inventoryView: "inventory.view",
  inventoryAdjust: "inventory.adjust",
  purchasesManage: "purchases.manage",

  /**
   * Parties — «اشخاص»: the one record behind a customer, a supplier and a
   * member of staff (migration 0137 renamed `customers` to `parties`, and this
   * permission is why the ledger can hand a supplier file to the same screen as a
   * customer's). `parties.view` is the read of the record and of the pickers that
   * depend on it; `parties.manage` is the write, and it is deliberately *not*
   * enough to change the accounting number and the tax rate of a party the ledger
   * settles against — those two fields are additionally gated on `ledger.view`.
   */
  partiesView: "parties.view",
  partiesManage: "parties.manage",

  /**
   * CRM — the relationship layer on top of «اشخاص».
   *
   * Separate from `parties.*` because they answer different questions.
   * `parties.manage` is "may correct this person's phone number", which a
   * cashier needs a dozen times a shift. The permissions below are "may read
   * everyone's purchase history", "may merge two customers irreversibly", "may
   * decide who can be marketed to" — each of which is a different kind of
   * trust, and bundling them into one `crm.manage` would mean granting a
   * junior salesperson the ability to destroy the directory in order to let
   * them log a phone call.
   *
   * The split is by *blast radius*, not by screen:
   */
  /** Read the 360° file, pipeline, segments and reports. */
  crmView: "crm.view",
  /** Day-to-day relationship work: notes, tasks, activities, cases, deals. */
  crmManage: "crm.manage",
  /**
   * Merge two customer records. **Irreversible** — it rewrites every order,
   * invoice and receipt that pointed at the loser and archives it. Its own
   * permission because it is the only CRM action that cannot be undone, and
   * because "clean up the duplicates" is exactly the task a business delegates
   * to its newest employee.
   */
  crmMerge: "crm.merge",
  /**
   * Change marketing consent. Consent is a legal record, not a preference:
   * whoever holds this can make the business's messaging lawful or unlawful.
   */
  crmConsentManage: "crm.consent_manage",
  /**
   * Export customer data — CSV, segment downloads, directory dumps. Reading
   * one customer's file on screen and walking out with the whole customer list
   * are not the same act, and only the second one is how a directory ends up
   * at a competitor.
   */
  crmExport: "crm.export",
  /**
   * Reconfigure pipelines, stages and segment definitions. Structural: a stage
   * rename or deletion reshapes every historical report built on it.
   */
  crmConfigure: "crm.configure",

  // Accounting
  ledgerView: "ledger.view",
  ledgerPost: "ledger.post",
  ledgerApprove: "ledger.approve",
  ledgerClosePeriod: "ledger.close_period",
  accountsEdit: "accounts.edit",

  // Insight
  reportsView: "reports.view",
  reportsExport: "reports.export",

  // Administration
  teamManage: "team.manage",
  settingsManage: "settings.manage",
  locationsManage: "locations.manage",
  backupManage: "backup.manage",
  // Phase 19: long-lived third-party credentials remain owner-only in V1.
  apiManage: "api.manage",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/**
 * Permissions that must never be delegated through member overrides. A leaked
 * API credential has a larger and more durable blast radius than ordinary
 * back-office access, so V1 keeps its lifecycle exclusively with the owner.
 */
export const OWNER_ONLY_PERMISSIONS: readonly Permission[] = [PERMISSIONS.apiManage];

export function isOwnerOnlyPermission(permission: Permission): boolean {
  return OWNER_ONLY_PERMISSIONS.includes(permission);
}

const {
  ordersCreate, ordersVoid, ordersAmendClosed, ordersBackdate, ordersDiscount, paymentsTake, paymentsRefund,
  tablesManage, reservationsManage, kitchenView, deliveryManage,
  menuView, menuEdit,
  inventoryView, inventoryAdjust, purchasesManage,
  partiesView, partiesManage,
  crmView, crmManage, crmMerge, crmConsentManage, crmExport, crmConfigure,
  ledgerView, ledgerPost, ledgerApprove, ledgerClosePeriod, accountsEdit,
  reportsView, reportsExport,
  teamManage, settingsManage, locationsManage, backupManage,
} = PERMISSIONS;

/**
 * What each system role can do out of the box.
 *
 * `owner` is deliberately absent: it is not a list but a rule (see
 * `roleBasePermissions`). Giving the owner an enumerated set would mean every
 * new permission added later silently excludes them.
 */
const ROLE_PRESETS: Record<Exclude<Role, "owner">, Permission[]> = {
  manager: [
    ordersCreate, ordersVoid, ordersAmendClosed, ordersBackdate, ordersDiscount, paymentsTake, paymentsRefund,
    tablesManage, reservationsManage, kitchenView, deliveryManage,
    menuView, menuEdit,
    inventoryView, inventoryAdjust, purchasesManage,
    partiesView, partiesManage,
    // The manager reached every CRM screen before these permissions existed
    // (the routes gated on requireRole("owner","manager")), so the preset
    // grants all of them. Introducing a permission must not quietly remove
    // access somebody already had — that is an outage, not a security
    // improvement. A business that wants a narrower manager revokes
    // individual capabilities per member.
    crmView, crmManage, crmMerge, crmConsentManage, crmExport, crmConfigure,
    ledgerView, reportsView, reportsExport,
    settingsManage, backupManage,
  ],
  // Phase 16's role: the books, and only the books. No till, no floor. Manages
  // the «اشخاص» file inside the Accounting app (its own customers, suppliers
  // and staff view with the ledger's columns) — the CRM app itself stays
  // closed to this role, so the 360° file, segments and notes are not a back
  // door into customer PII without an accounting reason.
  accountant: [
    menuView,
    inventoryView,
    partiesView, partiesManage,
    ledgerView, ledgerPost, ledgerApprove, ledgerClosePeriod, accountsEdit,
    reportsView, reportsExport,
  ],
  cashier: [
    ordersCreate, ordersDiscount, paymentsTake,
    tablesManage, reservationsManage,
    menuView, deliveryManage,
    inventoryView,
    partiesView, partiesManage,
    // Matches what the CRM nav already showed a cashier (directory, persons,
    // activities, cases) — logging that a customer called is floor work. No
    // crmView: the 360° file, segments and pipeline are not. No merge, no
    // consent, no export.
    crmManage,
  ],
  waiter: [
    ordersCreate,
    tablesManage, reservationsManage,
    menuView,
  ],
  kitchen: [
    kitchenView,
    menuView,
  ],
};

/** Per-member adjustments layered on top of the role preset. */
export interface PermissionOverrides {
  granted?: string[];
  revoked?: string[];
}

/** True when this role holds every permission unconditionally. */
export function isAbsoluteRole(role: Role): role is "owner" {
  return role === "owner";
}

/** The preset for a role, before any per-member overrides. */
export function roleBasePermissions(role: Role): Permission[] {
  if (isAbsoluteRole(role)) return [...ALL_PERMISSIONS];
  return [...(ROLE_PRESETS[role] ?? [])];
}

function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as string[]).includes(value);
}

/**
 * The effective permission set: preset ∪ granted \ revoked.
 *
 * Unknown keys in the overrides are ignored rather than throwing — a stored
 * override naming a permission that a later release removed must not be able
 * to break every request that member makes.
 *
 * An owner's set is not reducible. A business that could revoke its way out of
 * `team.manage` on its only owner would be permanently locked out of itself,
 * so overrides are simply not applied to an absolute role.
 */
export function effectivePermissions(
  role: Role,
  overrides: PermissionOverrides | null | undefined,
): Set<Permission> {
  const base = new Set(roleBasePermissions(role));
  if (isAbsoluteRole(role) || !overrides) return base;

  for (const key of overrides.granted ?? []) {
    if (isPermission(key) && !isOwnerOnlyPermission(key)) base.add(key);
  }
  for (const key of overrides.revoked ?? []) {
    if (isPermission(key)) base.delete(key);
  }
  return base;
}

/** Whether a member with this role and these overrides may do `permission`. */
export function hasPermission(
  role: Role,
  overrides: PermissionOverrides | null | undefined,
  permission: Permission,
): boolean {
  if (isAbsoluteRole(role)) return true;
  return effectivePermissions(role, overrides).has(permission);
}

/**
 * Normalises whatever was stored in `users.permissions` into overrides.
 *
 * The column is jsonb and therefore can hold anything, including values
 * written by an older release. Everything unrecognised degrades to "no
 * override" rather than throwing.
 */
export function parseOverrides(value: unknown): PermissionOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((item): item is string => typeof item === "string") : [];
  const removeOwnerOnly = (items: string[]) =>
    items.filter((item) => !isPermission(item) || !isOwnerOnlyPermission(item));
  return {
    granted: removeOwnerOnly(list(raw.granted)),
    revoked: removeOwnerOnly(list(raw.revoked)),
  };
}
