/**
 * Pre-built F&B chart of accounts template (Persian).
 * The wizard offers this as the default; the user can edit/add/remove rows
 * before the accounts are created. Codes follow the common 4-digit convention:
 * 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue, 5xxx expenses.
 */

import type { Industry } from "./industries";

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface TemplateAccount {
  code: string;
  name: string;
  type: AccountType;
  /** code of the parent account, if any */
  parentCode?: string;
  /** A contra/reducing account (moves opposite its type's normal balance) — e.g. sales returns, an NRV allowance. */
  isContra?: boolean;
}

/**
 * The standard Iranian-accounting four-tier chart-of-accounts hierarchy:
 * گروه (group) → کل (kol) → معین (moein) → تفصیلی (tafsili). Derived from an
 * account's position in the parent_id chain, never chosen directly — see
 * `nextAccountLevel`.
 */
export type AccountLevel = "group" | "kol" | "moein" | "tafsili";

export const ACCOUNT_LEVELS: AccountLevel[] = ["group", "kol", "moein", "tafsili"];

export const ACCOUNT_LEVEL_LABELS: Record<AccountLevel, string> = {
  group: "گروه",
  kol: "کل",
  moein: "معین",
  tafsili: "تفصیلی",
};

/**
 * The level one step more detailed than `parentLevel` (group → kol → moein →
 * tafsili), or `null` if `parentLevel` is already the deepest tier — a
 * تفصیلی account can't have children. A `null` parent (no parent at all) is
 * always `group`.
 */
export function nextAccountLevel(parentLevel: AccountLevel | null): AccountLevel | null {
  if (parentLevel === null) return "group";
  const idx = ACCOUNT_LEVELS.indexOf(parentLevel);
  return idx < ACCOUNT_LEVELS.length - 1 ? ACCOUNT_LEVELS[idx + 1] : null;
}

export type NormalBalance = "debit" | "credit";

/** Asset/expense accounts carry a debit normal balance; liability/equity/revenue carry credit. */
export function normalBalanceForType(type: AccountType): NormalBalance {
  return type === "asset" || type === "expense" ? "debit" : "credit";
}

/**
 * Accounts other parts of the system rely on (opening balances, Phase 7
 * auto-posting). Revenue isn't split by menu category here (no
 * category → account mapping exists in the schema — see Phase 7 doc), so
 * every order posts to one general `salesRevenue` account; 4100/4200 stay
 * available for manual/future per-category use.
 */
export const WELL_KNOWN_CODES = {
  cash: "1100",
  bankClearing: "1120",
  accountsReceivable: "1200",
  supplierReceivable: "1210",
  vatReceivable: "1220",
  // Issue #160 §4 — the last of Wave 4's three deferrals. What SnapFood owes
  // the business after taking its commission (money hasn't arrived yet —
  // SnapFood settles on its own schedule). See migrations/0060.
  platformReceivable: "1230",
  inventory: "1300",
  inventoryInTransit: "1350",
  nrvAllowance: "1390",
  accountsPayable: "2100",
  vatPayable: "2200",
  salariesPayable: "2300",
  // Tip capture (issue #160 §4) — a pass-through liability owed to staff,
  // not revenue. See migrations/0059_tip_capture.sql for the product
  // decisions this rests on.
  tipsPayable: "2400",
  openingEquity: "3900",
  historicalInventoryReconciliationEquity: "3950",
  retainedEarnings: "3800",
  salesRevenue: "4300",
  // Phase 22 Wave 4 — revenue split by sales channel. Order payment posts to
  // one of these three instead of the flat salesRevenue above, keyed off
  // orders.type (dine_in/takeaway/delivery — no new schema needed, that
  // column has existed since Phase 0). salesRevenue itself stays in the
  // template for historical entries and manual/other use, but no longer
  // receives new auto-postings.
  dineInRevenue: "4310",
  takeawayRevenue: "4320",
  deliveryRevenue: "4330",
  salesReturns: "4400",
  cogs: "5100",
  wasteExpense: "5150",
  salariesExpense: "5200",
  inventoryCountExpense: "5160",
  inventoryWriteDownExpense: "5170",
  inventoryCountGain: "4910",
  // Phase 22 Wave 4 — cost of using a third-party online-ordering platform
  // (e.g. a delivery marketplace's cut of the sale). Settled via the manual-
  // journal workflow, the same "new well-known account, not deep posting-path
  // integration" pattern Phase 16 used for input VAT — there's no "platform"
  // order-source concept in the schema yet to auto-post against.
  platformCommissionExpense: "5650",
  // Phase 22 Wave 5 — fixed-asset depreciation. accumulatedDepreciation is a
  // contra-asset (see coa-template.ts's isContra flag below), reducing the
  // fixed-asset line it's parented under.
  accumulatedDepreciation: "1510",
  depreciationExpense: "5700",
  // Phase 21 Wave 3 — jewelry (JEWELRY_COA_TEMPLATE below), not seeded for
  // an F&B business. goldSalesRevenue and makingChargeRevenue are kept as
  // two separate accounts (not folded into one "gold sales" line) because
  // they need to be reported separately for VAT: metal value is VAT-exempt
  // in Iranian tax practice, making charge + profit is not (see
  // src/lib/gold-pricing.ts).
  goldInventory: "1320",
  goldSalesRevenue: "4500",
  makingChargeRevenue: "4600",
  goldCogs: "5110",
  // Phase 21 Wave 4 — consignment (امانی). A consigned sale never touches
  // goldInventory/goldCogs (the shop never owned the piece) or
  // goldSalesRevenue/makingChargeRevenue (that money isn't the shop's
  // revenue, it's owed to the consignor) — it posts to these two instead.
  consignmentPayable: "2110",
  consignmentCommissionRevenue: "4700",
  // Phase 21 Wave 5 — watch (WATCH_COA_TEMPLATE below). A watch sale is an
  // ordinary finished-goods sale (no VAT-exempt component the way gold's
  // metal value is), so it needs only the usual inventory/revenue/COGS
  // triple. Repairs are the industry's second revenue stream and are kept
  // separate from unit sales — a shop wants to know what it earns servicing
  // watches vs. selling them, and the parts it consumes are a cost of that
  // service, not of a sale.
  watchInventory: "1330",
  watchSalesRevenue: "4550",
  watchCogs: "5120",
  repairServiceRevenue: "4800",
  repairPartsExpense: "5130",
  // Phase 21 Wave 6 — accessories (بدلیجات, ACCESSORIES_COA_TEMPLATE
  // below). Same three-account shape as watch: variant stock is ordinary
  // finished goods bought and resold, with no industry-specific split.
  accessoryInventory: "1340",
  accessorySalesRevenue: "4560",
  accessoryCogs: "5140",
} as const;

/**
 * Well-known expense codes that are cost of sales (material cost + inventory
 * shrinkage), not overhead — the "by function" split (COGS vs. SG&A) a
 * multi-step income statement needs for gross profit. Labor (`salariesExpense`)
 * is tracked separately since COGS + labor = "prime cost", the standard F&B
 * management metric; everything else in `type='expense'` is operating expense.
 */
export const COST_OF_SALES_CODES: readonly string[] = [
  WELL_KNOWN_CODES.cogs,
  WELL_KNOWN_CODES.wasteExpense,
  WELL_KNOWN_CODES.inventoryCountExpense,
  WELL_KNOWN_CODES.inventoryWriteDownExpense,
];

export const FNB_COA_TEMPLATE: TemplateAccount[] = [
  { code: "1000", name: "دارایی‌ها", type: "asset" },
  { code: "1100", name: "صندوق", type: "asset", parentCode: "1000" },
  { code: "1110", name: "بانک", type: "asset", parentCode: "1000" },
  { code: "1120", name: "کارت‌خوان (در راه)", type: "asset", parentCode: "1000" },
  { code: "1200", name: "حساب‌های دریافتنی", type: "asset", parentCode: "1000" },
  { code: "1210", name: "دریافتنی از تأمین‌کننده", type: "asset", parentCode: "1000" },
  { code: "1220", name: "مالیات بر ارزش افزوده خرید (قابل استرداد)", type: "asset", parentCode: "1000" },
  { code: "1230", name: "مطالبات از پلتفرم‌های سفارش آنلاین", type: "asset", parentCode: "1000" },
  { code: "1300", name: "موجودی مواد و کالا", type: "asset", parentCode: "1000" },
  { code: "1350", name: "موجودی در راه", type: "asset", parentCode: "1000" },
  { code: "1390", name: "ذخیره کاهش ارزش موجودی", type: "asset", parentCode: "1000", isContra: true },
  { code: "1400", name: "پیش‌پرداخت‌ها", type: "asset", parentCode: "1000" },
  { code: "1500", name: "اثاثه و تجهیزات", type: "asset", parentCode: "1000" },
  { code: "1510", name: "استهلاک انباشته", type: "asset", parentCode: "1500", isContra: true },

  { code: "2000", name: "بدهی‌ها", type: "liability" },
  { code: "2100", name: "حساب‌های پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2200", name: "مالیات بر ارزش افزوده پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2300", name: "حقوق پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2400", name: "انعام پرداختنی", type: "liability", parentCode: "2000" },

  { code: "3000", name: "حقوق صاحبان سرمایه", type: "equity" },
  { code: "3100", name: "سرمایه", type: "equity", parentCode: "3000" },
  { code: "3800", name: "سود (زیان) انباشته", type: "equity", parentCode: "3000" },
  { code: "3900", name: "تراز افتتاحیه", type: "equity", parentCode: "3000" },
  { code: "3950", name: "حقوق تطبیق تاریخی موجودی", type: "equity", parentCode: "3000" },

  { code: "4000", name: "درآمدها", type: "revenue" },
  { code: "4100", name: "فروش غذا", type: "revenue", parentCode: "4000" },
  { code: "4200", name: "فروش نوشیدنی", type: "revenue", parentCode: "4000" },
  { code: "4300", name: "فروش (عمومی)", type: "revenue", parentCode: "4000" },
  { code: "4310", name: "فروش حضوری (سالن)", type: "revenue", parentCode: "4000" },
  { code: "4320", name: "فروش بیرون‌بر", type: "revenue", parentCode: "4000" },
  { code: "4330", name: "فروش ارسالی", type: "revenue", parentCode: "4000" },
  { code: "4400", name: "برگشت از فروش", type: "revenue", parentCode: "4000", isContra: true },
  { code: "4900", name: "سایر درآمدها", type: "revenue", parentCode: "4000" },
  { code: "4910", name: "درآمد اضافه شمارش موجودی", type: "revenue", parentCode: "4000" },

  { code: "5000", name: "هزینه‌ها", type: "expense" },
  { code: "5100", name: "بهای تمام‌شده مواد", type: "expense", parentCode: "5000" },
  { code: "5150", name: "ضایعات مواد", type: "expense", parentCode: "5000" },
  { code: "5160", name: "هزینه کسری و مغایرت شمارش", type: "expense", parentCode: "5000" },
  { code: "5170", name: "هزینه کاهش ارزش موجودی", type: "expense", parentCode: "5000" },
  { code: "5200", name: "حقوق و دستمزد", type: "expense", parentCode: "5000" },
  { code: "5300", name: "اجاره", type: "expense", parentCode: "5000" },
  { code: "5400", name: "آب، برق و گاز", type: "expense", parentCode: "5000" },
  { code: "5500", name: "ملزومات مصرفی", type: "expense", parentCode: "5000" },
  { code: "5600", name: "بازاریابی و تبلیغات", type: "expense", parentCode: "5000" },
  { code: "5650", name: "کارمزد پلتفرم‌های سفارش آنلاین", type: "expense", parentCode: "5000" },
  { code: "5700", name: "هزینه استهلاک", type: "expense", parentCode: "5000" },
  { code: "5900", name: "سایر هزینه‌ها", type: "expense", parentCode: "5000" },
];

/**
 * Phase 21 Wave 3 — jewelry (طلا و جواهر) chart of accounts. Not yet seeded
 * by any wizard branch (jewelry isn't a selectable industry in `/welcome`
 * yet — see `ENABLED_INDUSTRIES`, `src/lib/industries.ts`); this exists so
 * the gold-sale posting rules (`src/lib/gold-posting-rules.ts`) and their
 * tests have real accounts to post against ahead of that wizard work.
 * Mirrors FNB_COA_TEMPLATE's structure, reusing every generic account
 * (cash, bank, AR, AP, VAT payable/receivable) and swapping the
 * inventory/revenue/COGS accounts for jewelry-appropriate ones.
 */
export const JEWELRY_COA_TEMPLATE: TemplateAccount[] = [
  { code: "1000", name: "دارایی‌ها", type: "asset" },
  { code: "1100", name: "صندوق", type: "asset", parentCode: "1000" },
  { code: "1110", name: "بانک", type: "asset", parentCode: "1000" },
  { code: "1120", name: "کارت‌خوان (در راه)", type: "asset", parentCode: "1000" },
  { code: "1200", name: "حساب‌های دریافتنی", type: "asset", parentCode: "1000" },
  { code: "1220", name: "مالیات بر ارزش افزوده خرید (قابل استرداد)", type: "asset", parentCode: "1000" },
  { code: "1320", name: "موجودی طلا و جواهر", type: "asset", parentCode: "1000" },
  { code: "1400", name: "پیش‌پرداخت‌ها", type: "asset", parentCode: "1000" },
  { code: "1500", name: "اثاثه و تجهیزات", type: "asset", parentCode: "1000" },

  { code: "2000", name: "بدهی‌ها", type: "liability" },
  { code: "2100", name: "حساب‌های پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2110", name: "پرداختنی به امانت‌گذاران", type: "liability", parentCode: "2000" },
  { code: "2200", name: "مالیات بر ارزش افزوده پرداختنی", type: "liability", parentCode: "2000" },

  { code: "3000", name: "حقوق صاحبان سرمایه", type: "equity" },
  { code: "3100", name: "سرمایه", type: "equity", parentCode: "3000" },
  { code: "3800", name: "سود (زیان) انباشته", type: "equity", parentCode: "3000" },
  { code: "3900", name: "تراز افتتاحیه", type: "equity", parentCode: "3000" },

  { code: "4000", name: "درآمدها", type: "revenue" },
  { code: "4500", name: "فروش طلا (ارزش فلز)", type: "revenue", parentCode: "4000" },
  { code: "4600", name: "درآمد اجرت و سود", type: "revenue", parentCode: "4000" },
  { code: "4700", name: "درآمد کارمزد فروش امانی", type: "revenue", parentCode: "4000" },
  { code: "4900", name: "سایر درآمدها", type: "revenue", parentCode: "4000" },

  { code: "5000", name: "هزینه‌ها", type: "expense" },
  { code: "5110", name: "بهای تمام‌شده طلای فروخته‌شده", type: "expense", parentCode: "5000" },
  { code: "5300", name: "اجاره", type: "expense", parentCode: "5000" },
  { code: "5400", name: "آب، برق و گاز", type: "expense", parentCode: "5000" },
  { code: "5600", name: "بازاریابی و تبلیغات", type: "expense", parentCode: "5000" },
  { code: "5900", name: "سایر هزینه‌ها", type: "expense", parentCode: "5000" },
];

/**
 * Phase 21 Wave 5 — watch (ساعت) chart of accounts. Mirrors
 * JEWELRY_COA_TEMPLATE's approach: every generic account (cash, bank, AR,
 * AP, VAT) is reused unchanged, and only the industry's own
 * inventory/revenue/COGS accounts differ — plus the two repair accounts, a
 * watch shop's second line of business (see WELL_KNOWN_CODES above).
 */
export const WATCH_COA_TEMPLATE: TemplateAccount[] = [
  { code: "1000", name: "دارایی‌ها", type: "asset" },
  { code: "1100", name: "صندوق", type: "asset", parentCode: "1000" },
  { code: "1110", name: "بانک", type: "asset", parentCode: "1000" },
  { code: "1120", name: "کارت‌خوان (در راه)", type: "asset", parentCode: "1000" },
  { code: "1200", name: "حساب‌های دریافتنی", type: "asset", parentCode: "1000" },
  { code: "1220", name: "مالیات بر ارزش افزوده خرید (قابل استرداد)", type: "asset", parentCode: "1000" },
  { code: "1330", name: "موجودی ساعت و قطعات", type: "asset", parentCode: "1000" },
  { code: "1400", name: "پیش‌پرداخت‌ها", type: "asset", parentCode: "1000" },
  { code: "1500", name: "اثاثه و تجهیزات", type: "asset", parentCode: "1000" },

  { code: "2000", name: "بدهی‌ها", type: "liability" },
  { code: "2100", name: "حساب‌های پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2200", name: "مالیات بر ارزش افزوده پرداختنی", type: "liability", parentCode: "2000" },

  { code: "3000", name: "حقوق صاحبان سرمایه", type: "equity" },
  { code: "3100", name: "سرمایه", type: "equity", parentCode: "3000" },
  { code: "3800", name: "سود (زیان) انباشته", type: "equity", parentCode: "3000" },
  { code: "3900", name: "تراز افتتاحیه", type: "equity", parentCode: "3000" },

  { code: "4000", name: "درآمدها", type: "revenue" },
  { code: "4550", name: "فروش ساعت", type: "revenue", parentCode: "4000" },
  { code: "4800", name: "درآمد تعمیرات", type: "revenue", parentCode: "4000" },
  { code: "4900", name: "سایر درآمدها", type: "revenue", parentCode: "4000" },

  { code: "5000", name: "هزینه‌ها", type: "expense" },
  { code: "5120", name: "بهای تمام‌شده ساعت فروخته‌شده", type: "expense", parentCode: "5000" },
  { code: "5130", name: "بهای قطعات مصرفی تعمیرات", type: "expense", parentCode: "5000" },
  { code: "5300", name: "اجاره", type: "expense", parentCode: "5000" },
  { code: "5400", name: "آب، برق و گاز", type: "expense", parentCode: "5000" },
  { code: "5600", name: "بازاریابی و تبلیغات", type: "expense", parentCode: "5000" },
  { code: "5900", name: "سایر هزینه‌ها", type: "expense", parentCode: "5000" },
];

/**
 * Phase 21 Wave 6 — accessories (بدلیجات) chart of accounts. The thinnest
 * of the four: accessories are ordinary finished goods bought and resold in
 * variant matrices, with no weight, no serial identity, and no service
 * line — so this is the generic template plus one inventory/revenue/COGS
 * triple of its own.
 */
export const ACCESSORIES_COA_TEMPLATE: TemplateAccount[] = [
  { code: "1000", name: "دارایی‌ها", type: "asset" },
  { code: "1100", name: "صندوق", type: "asset", parentCode: "1000" },
  { code: "1110", name: "بانک", type: "asset", parentCode: "1000" },
  { code: "1120", name: "کارت‌خوان (در راه)", type: "asset", parentCode: "1000" },
  { code: "1200", name: "حساب‌های دریافتنی", type: "asset", parentCode: "1000" },
  { code: "1220", name: "مالیات بر ارزش افزوده خرید (قابل استرداد)", type: "asset", parentCode: "1000" },
  { code: "1340", name: "موجودی بدلیجات", type: "asset", parentCode: "1000" },
  { code: "1400", name: "پیش‌پرداخت‌ها", type: "asset", parentCode: "1000" },
  { code: "1500", name: "اثاثه و تجهیزات", type: "asset", parentCode: "1000" },

  { code: "2000", name: "بدهی‌ها", type: "liability" },
  { code: "2100", name: "حساب‌های پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2200", name: "مالیات بر ارزش افزوده پرداختنی", type: "liability", parentCode: "2000" },

  { code: "3000", name: "حقوق صاحبان سرمایه", type: "equity" },
  { code: "3100", name: "سرمایه", type: "equity", parentCode: "3000" },
  { code: "3800", name: "سود (زیان) انباشته", type: "equity", parentCode: "3000" },
  { code: "3900", name: "تراز افتتاحیه", type: "equity", parentCode: "3000" },

  { code: "4000", name: "درآمدها", type: "revenue" },
  { code: "4560", name: "فروش بدلیجات", type: "revenue", parentCode: "4000" },
  { code: "4900", name: "سایر درآمدها", type: "revenue", parentCode: "4000" },

  { code: "5000", name: "هزینه‌ها", type: "expense" },
  { code: "5140", name: "بهای تمام‌شده بدلیجات فروخته‌شده", type: "expense", parentCode: "5000" },
  { code: "5300", name: "اجاره", type: "expense", parentCode: "5000" },
  { code: "5400", name: "آب، برق و گاز", type: "expense", parentCode: "5000" },
  { code: "5600", name: "بازاریابی و تبلیغات", type: "expense", parentCode: "5000" },
  { code: "5900", name: "سایر هزینه‌ها", type: "expense", parentCode: "5000" },
];

export const ACCOUNT_TYPES: AccountType[] = ["asset", "liability", "equity", "revenue", "expense"];

/**
 * The seed chart of accounts an industry starts from. One place, because
 * three call sites need the same answer: `seedChartOfAccounts`
 * (business-provisioning.ts, the platform console's path),
 * `/api/setup/accounts`'s GET (the wizard's path), and the wizard copy that
 * names the template. Two industries could get away with a ternary in each;
 * four cannot.
 */
export function coaTemplateForIndustry(industry: Industry): readonly TemplateAccount[] {
  switch (industry) {
    case "jewelry":
      return JEWELRY_COA_TEMPLATE;
    case "watch":
      return WATCH_COA_TEMPLATE;
    case "accessories":
      return ACCESSORIES_COA_TEMPLATE;
    case "food_service":
      return FNB_COA_TEMPLATE;
  }
}

/**
 * Validate a (possibly user-edited) account list before creation.
 * Returns error strings (Persian, shown directly in the wizard); empty = valid.
 */
export function validateAccounts(accounts: TemplateAccount[]): string[] {
  const errors: string[] = [];
  if (accounts.length === 0) {
    errors.push("حداقل یک حساب لازم است.");
    return errors;
  }
  const codes = new Set<string>();
  for (const a of accounts) {
    if (!a.code?.trim()) errors.push(`حساب «${a.name || "?"}» کد ندارد.`);
    else if (codes.has(a.code)) errors.push(`کد حساب «${a.code}» تکراری است.`);
    else codes.add(a.code);
    if (!a.name?.trim()) errors.push(`حساب با کد «${a.code}» نام ندارد.`);
    if (!ACCOUNT_TYPES.includes(a.type)) errors.push(`نوع حساب «${a.code}» نامعتبر است.`);
  }
  for (const a of accounts) {
    if (a.parentCode && !codes.has(a.parentCode)) {
      errors.push(`حساب والد «${a.parentCode}» برای «${a.code}» وجود ندارد.`);
    }
    if (a.parentCode === a.code) {
      errors.push(`حساب «${a.code}» نمی‌تواند والد خودش باشد.`);
    }
  }
  return errors;
}
