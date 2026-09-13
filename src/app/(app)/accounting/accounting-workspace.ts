/**
 * The complete Accounting workspace menu — what «حسابداری» actually contains.
 *
 * The problem this file exists to fix: Accounting *was* the whole ledger and
 * nothing else. Opening it dropped you straight into «فضای کار حسابداری» —
 * تراز آزمایشی، دفتر روزنامه، اسناد، اشخاص، دریافت و پرداخت — while everything
 * a business does that the ledger then records (فروش و فاکتور، خرید و انبار،
 * محصولات، گزارش‌ها، عملیات صنف) lived in a *second* main menu at
 * `/dashboard/*`. Two competing "main" navigations for one product, and the
 * one called «حسابداری» was the narrower of the two.
 *
 * So Accounting is the primary workspace, and the ledger is a named group
 * inside it. Concretely:
 *
 *  - the **work areas** (sales, purchases, inventory, products, reports, the
 *    trade's own operational screens) are the business nav entries that
 *    already exist. They are *picked out of* the list the shell already built
 *    — `navItems`, with every module / role / feature / permission filter
 *    already applied — and never re-declared here. A business whose trade has
 *    no انبار has no انبار row, because the entry was never in the list.
 *  - the **ledger sections** are `ACCOUNTING_SECTIONS`, unchanged, gathered
 *    into one group called «فضای کار حسابداری» so the words on the screen
 *    match the words in the product.
 *
 * Framework-free (no React, no JSX, no icons) like `accounting-nav.ts` beside
 * it, so the same composition is testable and can be read by the server nav
 * builder as well as by the client sidebar.
 */

import type { AccountingSectionKey } from "./accounting-routes";
import { accountingSectionHref } from "./accounting-routes";
import { accountingSectionsForRole, type AccountingSectionDef } from "./accounting-nav";
import { partyDirectoryHref } from "@/lib/party-directory";

/** A nav entry as the composer needs it — the business nav's shape, narrowed. */
export interface WorkspaceNavEntry {
  label: string;
  href: string;
  /** Set when this entry came from a business page rather than an accounting section. */
  external?: boolean;
  /** The Accounting section this entry is, when it is one. Decides the glyph and the active rule. */
  section?: AccountingSectionKey;
  /** The nav icon key, for an entry drawn from the business nav. */
  iconKey?: string;
}

export interface WorkspaceNavGroup {
  /** The group's own id, stable across renders — used for the open/closed memory. */
  key: string;
  label: string;
  /** One line under the heading, for the groups whose contents are not obvious. */
  description?: string;
  entries: WorkspaceNavEntry[];
  /**
   * A group that discloses rather than always being open. «فضای کار حسابداری»
   * is the long one — fifteen ledger tools — and it is the group a
   * non-accountant opens least often, so it starts closed unless you are
   * standing in it.
   */
  collapsible?: boolean;
}

/** The business nav entries this menu is willing to adopt, by href, in menu order. */
interface WorkspaceSlot {
  /** The business nav href to look for. */
  href: string;
  /** Override the business nav's own label when Accounting calls it something else. */
  label?: string;
}

/**
 * Which business pages belong in which Accounting group.
 *
 * Matched on href rather than on label or module: the label is the trade's
 * word for the page («فروش و فاکتور» in a jewellery shop, «صندوق (فروش)» in a
 * café) and must stay the trade's word, while the href is the stable identity
 * of the page. A page not in this table is simply not adopted, which is how
 * «مرکز آموزش» and «پشتیبانی» stay out of a work menu without being filtered
 * by a rule that could accidentally catch something else.
 */
const WORKSPACE_GROUP_SLOTS: readonly { key: string; label: string; description?: string; slots: readonly WorkspaceSlot[] }[] = [
  {
    key: "sales",
    label: "فروش و درآمد",
    description: "فاکتورها، صندوق و مشتریان",
    slots: [
      { href: "/dashboard/orders" },
      { href: "/dashboard/pos" },
      { href: "/crm/overview", label: "ارتباط با مشتری" },
    ],
  },
  {
    key: "purchasing",
    label: "خرید و انبار",
    description: "تأمین، موجودی و کالا",
    slots: [
      { href: "/dashboard/stock" },
      { href: "/dashboard/inventory" },
      { href: "/dashboard/products" },
      { href: "/dashboard/products/new" },
      { href: "/dashboard/products/prices" },
      { href: "/dashboard/menu" },
    ],
  },
  {
    key: "operations",
    label: "عملیات",
    description: "بخش‌های عملیاتی این صنف",
    slots: [
      { href: "/dashboard/floor" },
      { href: "/dashboard/waiter" },
      { href: "/dashboard/kitchen" },
      { href: "/dashboard/reservations" },
      { href: "/dashboard/delivery" },
      { href: "/dashboard/jewelry" },
      { href: "/dashboard/watch" },
      { href: "/dashboard/cosmetics" },
      { href: "/dashboard/accessories" },
      { href: "/dashboard/wholesale" },
      { href: "/dashboard/tools-fittings" },
      { href: "/dashboard/haberdashery" },
    ],
  },
];

/** The reports group's business entries — kept apart because it sits after the ledger. */
const REPORTS_SLOTS: readonly WorkspaceSlot[] = [
  { href: "/dashboard/reports", label: "گزارش‌های کسب‌وکار" },
];

/** The configuration group's business entries. */
const CONFIG_SLOTS: readonly WorkspaceSlot[] = [
  { href: "/settings", label: "تنظیمات کسب‌وکار" },
  { href: "/settings/connections" },
  { href: "/websites/overview", label: "وب‌سایت" },
  { href: "/settings/billing" },
];

/**
 * The ledger's own sections, in the order «فضای کار حسابداری» lists them.
 *
 * Everything `ACCOUNTING_SECTIONS` holds except the four that are not ledger
 * tools: the app's home (a group of its own at the top), the directory (the
 * people group), the reports index and the growth view (the reports group),
 * and the app's settings (the configuration group).
 */
export const LEDGER_WORKSPACE_SECTION_KEYS: readonly AccountingSectionKey[] = [
  "trial-balance",
  "entries",
  "manual",
  "chart-of-accounts",
  "receivables",
  "payables",
  "receipts",
  "installments",
  "cheques",
  "expenses",
  "reconciliation",
  "fixed-assets",
  "fiscal-periods",
  "vat",
  "payroll",
];

/** The label «فضای کار حسابداری» wears wherever it is drawn — menu and page alike. */
export const LEDGER_WORKSPACE_LABEL = "فضای کار حسابداری";
export const LEDGER_WORKSPACE_DESCRIPTION = "دفتر، اسناد و عملیات مالی";
export const LEDGER_WORKSPACE_GROUP_KEY = "ledger";

/**
 * Compose the Accounting app's complete menu.
 *
 * `navItems` is the business nav the shell already built and already filtered;
 * the composer only *arranges* it. A slot whose page this member cannot reach
 * is absent from that list, so it is absent here — no second gate, and no way
 * for the two to disagree.
 */
export function accountingWorkspaceGroups({
  role,
  navItems,
}: {
  role: string | null | undefined;
  /** The business nav, flattened (parents and children alike), already gated. */
  navItems: readonly { label: string; href: string; iconKey?: string }[];
}): WorkspaceNavGroup[] {
  const allowed = accountingSectionsForRole(role);
  const byKey = new Map<AccountingSectionKey, AccountingSectionDef>(
    allowed.map((section) => [section.key, section]),
  );
  const businessByHref = new Map(navItems.map((item) => [item.href, item]));

  const sectionEntry = (key: AccountingSectionKey, label?: string): WorkspaceNavEntry[] => {
    const section = byKey.get(key);
    if (!section) return [];
    return [{ label: label ?? section.label, href: accountingSectionHref(key), section: key }];
  };

  const businessEntries = (slots: readonly WorkspaceSlot[]): WorkspaceNavEntry[] =>
    slots.flatMap((slot) => {
      const item = businessByHref.get(slot.href);
      if (!item) return [];
      return [
        {
          label: slot.label ?? item.label,
          href: item.href,
          external: true,
          iconKey: item.iconKey ?? item.href,
        },
      ];
    });

  const groups: WorkspaceNavGroup[] = [];

  // 1. The main dashboard / workspace home: «میز کار» with «داشبورد حسابداری»
  const homeEntries = sectionEntry("dashboard", "داشبورد حسابداری");
  if (homeEntries.length > 0) {
    groups.push({
      key: "home",
      label: "میز کار",
      entries: homeEntries,
    });
  }

  // 2. The business work areas, in the order a day runs: sell, buy, operate.
  for (const group of WORKSPACE_GROUP_SLOTS) {
    const entries = businessEntries(group.slots);
    if (entries.length === 0) continue;
    groups.push({ key: group.key, label: group.label, description: group.description, entries });
  }

  // 3. The one people directory, with its useful views as deep links.
  const directory = sectionEntry("directory", "اشخاص");
  if (directory.length > 0) {
    groups.push({
      key: "people",
      label: "اشخاص",
      description: "مشتریان، تأمین‌کنندگان و کارکنان — یک فهرست",
      entries: [
        ...directory,
        { label: "مشتریان", href: partyDirectoryHref("customers"), section: "directory" },
        { label: "تأمین‌کنندگان", href: partyDirectoryHref("suppliers"), section: "directory" },
      ],
    });
  }

  // 4. «فضای کار حسابداری» — the ledger, as a named group inside this menu.
  const ledgerEntries = LEDGER_WORKSPACE_SECTION_KEYS.flatMap((key) => sectionEntry(key));
  if (ledgerEntries.length > 0) {
    groups.push({
      key: LEDGER_WORKSPACE_GROUP_KEY,
      label: LEDGER_WORKSPACE_LABEL,
      description: LEDGER_WORKSPACE_DESCRIPTION,
      entries: ledgerEntries,
      collapsible: true,
    });
  }

  // 5. Reports — the ledger's own, then the business's.
  const reports = [
    ...sectionEntry("reports", "گزارش‌های مالی"),
    ...businessEntries(REPORTS_SLOTS),
    ...sectionEntry("growth"),
  ];
  if (reports.length > 0) {
    groups.push({ key: "reports", label: "گزارش و تحلیل", entries: reports });
  }

  // 6. Configuration, last — the app's own settings first, then the platform's.
  const config = [
    ...sectionEntry("settings", "تنظیمات حسابداری"),
    ...businessEntries(CONFIG_SLOTS),
  ];
  if (config.length > 0) {
    groups.push({ key: "config", label: "پیکربندی", entries: config });
  }

  return groups;
}

/** Every href the composed menu offers — what a test and the bottom-nav picker read. */
export function accountingWorkspaceHrefs(groups: readonly WorkspaceNavGroup[]): string[] {
  return groups.flatMap((group) => group.entries.map((entry) => entry.href));
}
