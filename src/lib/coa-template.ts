/**
 * Pre-built F&B chart of accounts template (Persian).
 * The wizard offers this as the default; the user can edit/add/remove rows
 * before the accounts are created. Codes follow the common 4-digit convention:
 * 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue, 5xxx expenses.
 */

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface TemplateAccount {
  code: string;
  name: string;
  type: AccountType;
  /** code of the parent account, if any */
  parentCode?: string;
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
  inventory: "1300",
  inventoryInTransit: "1350",
  nrvAllowance: "1390",
  accountsPayable: "2100",
  vatPayable: "2200",
  salariesPayable: "2300",
  openingEquity: "3900",
  historicalInventoryReconciliationEquity: "3950",
  retainedEarnings: "3800",
  salesRevenue: "4300",
  salesReturns: "4400",
  cogs: "5100",
  wasteExpense: "5150",
  salariesExpense: "5200",
  inventoryCountExpense: "5160",
  inventoryWriteDownExpense: "5170",
  inventoryCountGain: "4910",
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
  { code: "1300", name: "موجودی مواد و کالا", type: "asset", parentCode: "1000" },
  { code: "1350", name: "موجودی در راه", type: "asset", parentCode: "1000" },
  { code: "1390", name: "ذخیره کاهش ارزش موجودی", type: "asset", parentCode: "1000" },
  { code: "1400", name: "پیش‌پرداخت‌ها", type: "asset", parentCode: "1000" },
  { code: "1500", name: "اثاثه و تجهیزات", type: "asset", parentCode: "1000" },

  { code: "2000", name: "بدهی‌ها", type: "liability" },
  { code: "2100", name: "حساب‌های پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2200", name: "مالیات بر ارزش افزوده پرداختنی", type: "liability", parentCode: "2000" },
  { code: "2300", name: "حقوق پرداختنی", type: "liability", parentCode: "2000" },

  { code: "3000", name: "حقوق صاحبان سرمایه", type: "equity" },
  { code: "3100", name: "سرمایه", type: "equity", parentCode: "3000" },
  { code: "3800", name: "سود (زیان) انباشته", type: "equity", parentCode: "3000" },
  { code: "3900", name: "تراز افتتاحیه", type: "equity", parentCode: "3000" },
  { code: "3950", name: "حقوق تطبیق تاریخی موجودی", type: "equity", parentCode: "3000" },

  { code: "4000", name: "درآمدها", type: "revenue" },
  { code: "4100", name: "فروش غذا", type: "revenue", parentCode: "4000" },
  { code: "4200", name: "فروش نوشیدنی", type: "revenue", parentCode: "4000" },
  { code: "4300", name: "فروش (عمومی)", type: "revenue", parentCode: "4000" },
  { code: "4400", name: "برگشت از فروش", type: "revenue", parentCode: "4000" },
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
  { code: "5900", name: "سایر هزینه‌ها", type: "expense", parentCode: "5000" },
];

export const ACCOUNT_TYPES: AccountType[] = ["asset", "liability", "equity", "revenue", "expense"];

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
