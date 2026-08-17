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

  // Customers
  customersView: "customers.view",
  customersManage: "customers.manage",

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
  customersView, customersManage,
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
    customersView, customersManage,
    ledgerView, reportsView, reportsExport,
    settingsManage, backupManage,
  ],
  // Phase 16's role: the books, and only the books. No till, no floor. Sees
  // the customer directory (it's where AR balances are attributed) but does
  // not manage customer records — that's a front-of-house task.
  accountant: [
    menuView,
    inventoryView,
    customersView,
    ledgerView, ledgerPost, ledgerApprove, ledgerClosePeriod, accountsEdit,
    reportsView, reportsExport,
  ],
  cashier: [
    ordersCreate, ordersDiscount, paymentsTake,
    tablesManage, reservationsManage,
    menuView, deliveryManage,
    inventoryView,
    customersView, customersManage,
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
