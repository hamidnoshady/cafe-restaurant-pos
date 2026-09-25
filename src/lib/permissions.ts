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
  ordersDiscount: "orders.discount",
  paymentsTake: "payments.take",
  paymentsRefund: "payments.refund",

  // Floor
  tablesManage: "tables.manage",
  /**
   * Reading the reservation book versus writing in it.
   *
   * Split because the two audiences really did differ: `GET /api/reservations`
   * was requireRole("owner","manager","cashier","waiter") while `POST` was
   * requireRole("owner","manager","cashier"). A waiter checks tonight's book;
   * taking the booking is the till's job. One `reservations.manage` covering
   * both would have quietly handed the waiter the write.
   */
  reservationsView: "reservations.view",
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
  /**
   * Delete a CRM record outright — a case, an activity — rather than close or
   * archive it.
   *
   * Its own key because deletion is not the destructive end of `crm.manage`
   * but a different act: `crm.manage` is floor work (logging that a customer
   * called) and a cashier has it, whereas `DELETE /api/crm/cases/[id]` was
   * requireRole("owner","manager") and destroys the record and its history.
   */
  crmDelete: "crm.delete",

  /**
   * My Workspace — «میز کار من» (Phase G).
   *
   * Split by blast radius, the same way the CRM block above is, because the
   * four acts are four different kinds of trust. `workspace.view` is "may see
   * the projects I am on"; `workspace.manage` is the day-to-day write across
   * projects, tasks, documents and the calendar; the remaining two are carved
   * out because each can commit the business to something.
   *
   * These gate the AREA. Which projects a member may touch, and how deeply, is
   * the member's project role in `workspace_members` (owner/manager/editor/
   * contributor/viewer) — the two are intersected, never substituted. That is
   * not a second permission system: a project role can only ever narrow what
   * the permission below already allows.
   */
  workspaceView: "workspace.view",
  workspaceManage: "workspace.manage",
  /**
   * Create and amend execution contracts. Its own key because a contract is a
   * financial commitment to a third party: whoever holds this can record that
   * the business owes a contractor 500 million Rial. Logging a site visit and
   * signing a supplier agreement are not the same act.
   */
  workspaceContractsManage: "workspace.contracts_manage",
  /**
   * Decide an approval. The approval gate exists precisely so that one person
   * proposes and another accepts; letting everyone who can request also
   * approve would make the whole mechanism decorative.
   */
  workspaceApprove: "workspace.approve",

  // Accounting authority — the books themselves. These stay narrow: they are
  // accounting *control*, not day-to-day business work, and the manager preset
  // deliberately holds none of them.
  ledgerView: "ledger.view",
  ledgerPost: "ledger.post",
  ledgerApprove: "ledger.approve",
  ledgerClosePeriod: "ledger.close_period",
  accountsEdit: "accounts.edit",
  /**
   * Drafting a manual journal entry — proposing, not posting.
   *
   * A draft has no effect on the ledger by itself; `/api/ledger/entries/drafts/
   * [id]/approve` is gated on `ledger.approve` and that is where the entry
   * actually lands. Separating "may propose" from "may post" is the entire
   * point of the review queue, so collapsing this into `ledger.post` would
   * make the queue decorative — and would take drafting away from the managers
   * who have always had it.
   */
  ledgerPropose: "ledger.propose",

  /**
   * Operational finance — money moving in and out of the business as a
   * consequence of ordinary trading, as opposed to accounting control.
   *
   * These exist because sixteen ledger write routes were using `role` as a
   * proxy for two different capabilities at once. Paying a supplier or taking
   * a customer receipt is work a manager legitimately performs; posting a
   * manual journal, approving one, closing a period or editing the chart of
   * accounts is accounting authority. Mapping the former onto `ledger.post`
   * would have either removed access every manager already had, or widened
   * `ledger.post` into something far broader than its name promises.
   *
   * They are named for the business action rather than the table that ends up
   * being written: each of these does produce accounting entries downstream,
   * but the user is recording a payment, not "posting to the ledger".
   */
  financeExpensesManage: "finance.expenses_manage",
  financeReceivablesManage: "finance.receivables_manage",
  financePayablesManage: "finance.payables_manage",
  financeChequesManage: "finance.cheques_manage",
  financeInstallmentsManage: "finance.installments_manage",
  financeReconciliationManage: "finance.reconciliation_manage",
  financeAssetsManage: "finance.assets_manage",

  /**
   * Payroll is its own realm: salary figures are sensitive in a way the rest
   * of the ledger is not, and the payroll routes were guarded
   * `requireRole("owner", "accountant")` — a strictly narrower audience than
   * the surrounding ledger surface. Without these keys the payroll reads would
   * have to ride on `ledger.view`, which the manager and viewer presets hold,
   * and every manager would suddenly see what everyone earns.
   */
  payrollView: "payroll.view",
  payrollManage: "payroll.manage",

  // Insight
  reportsView: "reports.view",
  reportsExport: "reports.export",

  /**
   * «ورود و خروج داده» — the platform-wide data transfer engine.
   *
   * These two gate the ENGINE, and are always intersected with the entity's
   * own permission, never substituted for it: exporting the customer directory
   * needs `data.export` AND `crm.export`; importing a menu needs `data.import`
   * AND `menu.edit`. That is deliberate and is the whole security model of the
   * module — one screen that reaches every app must not become a way around
   * any app's own gate.
   *
   * They exist as keys of their own because bulk transfer is a different kind
   * of trust from the per-record permission it sits on top of. Reading one
   * customer's file and walking out with fifty thousand rows of them are not
   * the same act; neither are correcting one price and replacing the entire
   * catalogue from a spreadsheet. A business that wants its CRM manager to
   * keep editing customers but never bulk-export them now revokes one key
   * instead of having no way to express it.
   *
   * Nobody loses access they had: every role whose preset already included a
   * bulk door (the manager's `crm.export`, the accountant's `reports.export`)
   * receives these, and no floor role had one to lose.
   */
  dataImport: "data.import",
  dataExport: "data.export",

  /**
   * Website & CMS — «مدیریت وب‌سایت».
   *
   * Before these keys existed every `/api/cms/website/*` route gated on
   * `requireRole("owner", "manager")`, which made "may edit a blog post" and
   * "may re-point the business's DNS" the same act. They are not: the first is
   * daily content work a business delegates to a junior marketer, the second
   * can take the public site off the internet. Split by blast radius, the same
   * way the CRM block above is:
   */
  /** Read the website state, overview, catalogue and drafts. */
  websiteView: "website.view",
  /** Day-to-day content work: drafts, posts, products, media, orders. */
  websiteManage: "website.manage",
  /**
   * Push a draft live. Its own key because publishing is the only content act
   * the public sees instantly and cannot be quietly undone before anyone
   * notices.
   */
  websitePublish: "website.publish",
  /**
   * Structural website administration: domains, DNS, CDN, provisioning,
   * connector settings. Whoever holds this can take the site offline.
   */
  websiteConfigure: "website.configure",

  /**
   * Growth — «رشد»: the marketing and customer-development app.
   *
   * Split into two pairs rather than one, because the app has two audiences
   * that were never the same people. The management surfaces — the growth
   * dashboard, campaigns, messaging, commission, the app's own settings — were
   * `requireRole("owner", "manager")`. The loyalty lookups are till work: a
   * cashier reads a customer's points and the programme list on every shift,
   * and `requireRole("owner", "manager", "cashier")` is what said so.
   *
   * One `growth.view` covering both would have handed the cashier the
   * management dashboard and the accountant the loyalty desk — a widening
   * disguised as a refactor. Two pairs reproduce the four existing audiences
   * exactly.
   */
  /** Read the growth dashboards and Growth's own customer screen. */
  growthView: "growth.view",
  /** Run campaigns, send messages, pay commission, configure the app. */
  growthManage: "growth.manage",
  /** Till-level loyalty reads: programmes, a customer's points, repurchase. */
  loyaltyView: "loyalty.view",
  /** Redeem points, grant store credit, define programmes. Moves value. */
  loyaltyManage: "loyalty.manage",

  // Administration
  /**
   * Read the team list and a member's access profile without being able to
   * change it. Carved out of `team.manage` so an auditor or a shift lead can
   * answer "who works here and what can they do" without also being able to
   * hand out permissions.
   */
  teamView: "team.view",
  teamManage: "team.manage",
  /**
   * Change a member's role or permission overrides. Separate from
   * `team.manage` (which covers creating staff, resetting a PIN, suspending)
   * because granting permissions is how a delegated team administrator would
   * escalate their own access.
   */
  teamPermissionsManage: "team.permissions_manage",
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
  ordersCreate, ordersVoid, ordersAmendClosed, ordersDiscount, paymentsTake, paymentsRefund,
  tablesManage, reservationsView, reservationsManage, kitchenView, deliveryManage,
  menuView, menuEdit,
  inventoryView, inventoryAdjust, purchasesManage,
  partiesView, partiesManage,
  crmView, crmManage, crmMerge, crmConsentManage, crmExport, crmConfigure, crmDelete,
  workspaceView, workspaceManage, workspaceContractsManage, workspaceApprove,
  ledgerView, ledgerPost, ledgerApprove, ledgerClosePeriod, accountsEdit, ledgerPropose,
  financeExpensesManage, financeReceivablesManage, financePayablesManage, financeChequesManage,
  financeInstallmentsManage, financeReconciliationManage, financeAssetsManage,
  payrollView, payrollManage,
  reportsView, reportsExport,
  dataImport, dataExport,
  websiteView, websiteManage, websitePublish, websiteConfigure,
  growthView, growthManage, loyaltyView, loyaltyManage,
  teamView, teamManage, teamPermissionsManage,
  settingsManage, locationsManage, backupManage,
} = PERMISSIONS;

/**
 * What each system role can do out of the box.
 *
 * `owner` is deliberately absent: it is not a list but a rule (see
 * `roleBasePermissions`). Giving the owner an enumerated set would mean every
 * new permission added later silently excludes them.
 */
const ROLE_PRESETS: Record<Exclude<Role, "owner" | "admin">, Permission[]> = {
  manager: [
    ordersCreate, ordersVoid, ordersAmendClosed, ordersDiscount, paymentsTake, paymentsRefund,
    tablesManage, reservationsView, reservationsManage, kitchenView, deliveryManage,
    menuView, menuEdit,
    inventoryView, inventoryAdjust, purchasesManage,
    partiesView, partiesManage,
    // The manager reached every CRM screen before these permissions existed
    // (the routes gated on requireRole("owner","manager")), so the preset
    // grants all of them. Introducing a permission must not quietly remove
    // access somebody already had — that is an outage, not a security
    // improvement. A business that wants a narrower manager revokes
    // individual capabilities per member.
    crmView, crmManage, crmMerge, crmConsentManage, crmExport, crmConfigure, crmDelete,
    // Phase G, same rule as the CRM block: before these keys existed the
    // project pages gated on requireMember, so every manager could already
    // open them and do everything on them. Introducing a permission must not
    // remove access somebody already had, so the preset grants all four. A
    // business that wants a narrower manager revokes the individual keys.
    workspaceView, workspaceManage, workspaceContractsManage, workspaceApprove,
    ledgerView, reportsView, reportsExport,
    // Phase L. Sixteen ledger write routes gated on
    // requireRole("owner","manager","accountant"), so the manager already did
    // every one of these jobs: recording expenses, taking receipts, paying
    // suppliers, handling cheques and instalments, reconciling a bank
    // statement, maintaining the fixed-asset register. Splitting that role
    // gate into named capabilities must not be the thing that takes the work
    // away, so the preset grants all seven — and, by the same rule, drafting a
    // manual journal for an accountant to approve. What the manager still does
    // NOT get is accounting authority: no ledger.post, approve, close_period
    // or accounts.edit, and no payroll.
    financeExpensesManage, financeReceivablesManage, financePayablesManage, financeChequesManage,
    financeInstallmentsManage, financeReconciliationManage, financeAssetsManage,
    ledgerPropose,
    // «ورود و خروج داده». The manager already held every bulk door the product
    // had (crm.export gated both the customer export AND the customer import;
    // reports.export gated the report download), so granting these two keeps
    // the access they had rather than handing them a new capability. The
    // engine still intersects them with each entity's own permission.
    dataImport, dataExport,
    // Website & Growth: every `/api/cms/website/*` and `/api/growth|loyalty/*`
    // route gated on requireRole("owner","manager") before these keys existed,
    // so the manager preset grants what the manager already reached. The one
    // `websiteConfigure` is included even though it is the highest-risk key of
    // the four: the manager could already reach the DNS, CDN, domain and
    // provisioning routes, and splitting a role-only gate into graded keys must
    // not be the thing that takes access away. The split's value is that the
    // capability is now *separable* — an owner can revoke it from one manager,
    // or grant website content work to a marketer who is not a manager at all.
    // The one website route that was owner-only (purchasing a domain, a
    // financial commitment) stays owner-only as a role gate.
    websiteView, websiteManage, websitePublish, websiteConfigure,
    growthView, growthManage, loyaltyView, loyaltyManage,
    settingsManage, backupManage,
  ],
  /**
   * Phase A — the tenant administrator, introduced by this refactor.
   *
   * Admin exists because `manager` had been doing two unrelated jobs: running
   * the business (orders, stock, the floor) and administering the tenant
   * (staff, branches, integrations). Bundling them meant a shift manager who
   * needed to void an order also got the ability to reconfigure the business.
   *
   * Admin is defined as a *rule* rather than a list, like the owner: every
   * capability except the ones the owner may not delegate. That way a
   * permission added in a later release does not silently exclude the role
   * whose entire purpose is "everything short of ownership".
   *
   * No existing tenant has an admin, so this preset cannot regress anybody.
   *
   * Computed in `roleBasePermissions`, not listed here.
   */
  // Phase 16's role: the books, and only the books. No till, no floor. Manages
  // the «اشخاص» file inside the Accounting app (its own customers, suppliers
  // and staff view with the ledger's columns) — the CRM app itself stays
  // closed to this role, so the 360° file, segments and notes are not a back
  // door into customer PII without an accounting reason.
  accountant: [
    menuView,
    inventoryView,
    partiesView, partiesManage,
    ledgerView, ledgerPost, ledgerApprove, ledgerClosePeriod, accountsEdit, ledgerPropose,
    // The accountant reached all sixteen operational-finance routes too, and
    // payroll was theirs alone alongside the owner.
    financeExpensesManage, financeReceivablesManage, financePayablesManage, financeChequesManage,
    financeInstallmentsManage, financeReconciliationManage, financeAssetsManage,
    payrollView, payrollManage,
    reportsView, reportsExport,
    // Same reasoning as the manager's: the accountant already downloaded the
    // financial statements through reports.export, and importing a chart of
    // accounts or a month of expenses is the accounting work this role exists
    // for. Which entities they may actually move is still decided by the
    // entity permissions above — no crm.export here, so no customer dump.
    dataImport, dataExport,
    // `/api/growth/accounting` and `/api/growth/customers` were
    // requireRole("owner","manager","accountant"), so the accountant keeps the
    // read they had. No growth.manage and no loyalty.*: running a campaign and
    // working the loyalty desk were never theirs.
    growthView,
    // A project is a cost centre the books post against (journal_entries
    // .project_id), so the accountant must be able to read the workspace and
    // the contracts whose values they are accruing. Read only: recording a
    // cost is accounting work, committing the business to a new contractor is
    // not.
    workspaceView,
  ],
  cashier: [
    ordersCreate, ordersDiscount, paymentsTake,
    tablesManage, reservationsView, reservationsManage,
    menuView, deliveryManage,
    inventoryView,
    partiesView, partiesManage,
    // Matches what the CRM nav already showed a cashier (directory, persons,
    // activities, cases) — logging that a customer called is floor work. No
    // crmView: the 360° file, segments and pipeline are not. No merge, no
    // consent, no export.
    crmManage,
    // Sees the projects they are a member of and works the tasks on them —
    // the floor-staff case the workspace is for. No contracts, no approvals.
    workspaceView, workspaceManage,
    // The loyalty lookups the till needs — a customer's points, the programme
    // list, the repurchase prompt — were requireRole("owner","manager",
    // "cashier"). Read only: redeeming points and granting store credit were
    // owner/manager routes and are now loyalty.manage. No growth.view either:
    // the growth dashboard and Growth's customer screen were never a cashier's.
    loyaltyView,
  ],
  waiter: [
    ordersCreate,
    // Reads tonight's book; taking the booking is the till's job, which is why
    // this is `reservationsView` and not `reservationsManage`.
    tablesManage, reservationsView,
    menuView,
    // Read-only: a waiter may be a contributor on a project (a refit, an
    // event) and needs to see the tasks assigned to them.
    workspaceView,
  ],
  kitchen: [
    kitchenView,
    menuView,
  ],
  /**
   * Phase A — the read-only auditor, introduced by this refactor.
   *
   * Broad sight, no mutation: every `*.view`-shaped capability and nothing
   * else. Deliberately WITHOUT `reports.export`, `crm.export` and
   * `data.export` — being allowed to read a figure on screen and being allowed
   * to walk out with the dataset behind it are different acts, and an external
   * accountant or a due-diligence reviewer is exactly the case where the
   * difference matters. A tenant that wants an exporting auditor grants the
   * export keys to that member individually.
   */
  viewer: [
    menuView,
    inventoryView,
    partiesView,
    crmView,
    reservationsView,
    workspaceView,
    ledgerView,
    reportsView,
    kitchenView,
    websiteView,
    growthView,
    loyaltyView,
    teamView,
  ],
};

/**
 * Roles whose permission set is a rule rather than a list, and what that rule
 * is. Keeping these out of ROLE_PRESETS is the point: a permission added in a
 * later release must be picked up automatically instead of silently excluding
 * the two roles defined as "everything (short of ownership)".
 */
function absolutePresetFor(role: Role): Permission[] | null {
  if (role === "owner") return [...ALL_PERMISSIONS];
  if (role === "admin") return ALL_PERMISSIONS.filter((p) => !isOwnerOnlyPermission(p));
  return null;
}

/** Per-member adjustments layered on top of the role preset. */
export interface PermissionOverrides {
  granted?: string[];
  revoked?: string[];
}

/** True when this role holds every permission unconditionally. */
export function isAbsoluteRole(role: Role): role is "owner" {
  return role === "owner";
}

/**
 * Every role the preset system resolves a set for: the two rule-derived
 * absolute-ish roles plus each role with a written preset.
 *
 * Exported so `roles.test.ts` can assert the catalogue and the permission
 * model agree. A role in one but not the other is a real defect — unassignable
 * in one direction, or a member who can sign in and do nothing in the other,
 * because `roleBasePermissions` falls back to an empty list.
 */
export const ROLE_PRESET_ROLES: readonly Role[] = [
  "owner",
  "admin",
  ...(Object.keys(ROLE_PRESETS) as (keyof typeof ROLE_PRESETS)[]),
];

/** The preset for a role, before any per-member overrides. */
export function roleBasePermissions(role: Role): Permission[] {
  return absolutePresetFor(role) ?? [...(ROLE_PRESETS[role as keyof typeof ROLE_PRESETS] ?? [])];
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
