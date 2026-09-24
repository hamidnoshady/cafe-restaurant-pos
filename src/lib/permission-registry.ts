/**
 * The permission catalogue: one description of every capability, in one place.
 *
 * ## Why a registry rather than more constants
 *
 * `permissions.ts` answers "what are the keys and who gets them by default".
 * It deliberately does not answer the questions a *user interface* has to ask
 * about a permission:
 *
 *   * What is this called in Persian, and what does it actually do?
 *   * Which group does it belong to in the role editor?
 *   * Is it dangerous enough to warn about before granting?
 *   * May a custom role or a per-member grant hand it out at all?
 *   * Does exercising it imply another capability (adjusting stock is useless
 *     without being able to see stock)?
 *
 * Before this file each of those was answered by whichever component happened
 * to need it, which is how the same permission ended up labelled two different
 * ways on two screens and how the role editor's "dangerous" styling covered a
 * different set of keys than the confirmation dialog did. Metadata about a
 * permission is a fact about the product, not a screen-local decision — the
 * same argument `role-labels.ts` makes for role names.
 *
 * Framework-free and type-only imports so client components and server code
 * can both read it.
 */
import { ALL_PERMISSIONS, isOwnerOnlyPermission, PERMISSIONS, type Permission } from "./permissions";

/**
 * How much damage holding this key can do, used for the role editor's warning
 * treatment and for deciding what needs a confirmation step.
 *
 *   low      — reading, or a write with no lasting consequence.
 *   medium   — ordinary operational writes.
 *   high     — money moves, data leaves the building, or history is rewritten.
 *   critical — the tenant's own security or continuity is at stake.
 */
export type PermissionRisk = "low" | "medium" | "high" | "critical";

/** Role-editor grouping. One group per screenful of related capability. */
export type PermissionGroup =
  | "orders"
  | "payments"
  | "floor"
  | "menu"
  | "inventory"
  | "parties"
  | "crm"
  | "workspace"
  | "accounting"
  | "reports"
  | "growth"
  | "website"
  | "data"
  | "team"
  | "settings"
  | "security";

export interface PermissionMetadata {
  key: Permission;
  group: PermissionGroup;
  label: string;
  description: string;
  risk: PermissionRisk;
  /**
   * Whether a custom role or a per-member grant may hand this out. False for
   * the owner-reserved capabilities — represented here, once, rather than as a
   * scattering of `if (role !== "owner")` checks.
   */
  delegatable: boolean;
  /** Only an owner ever holds this, however the tenant configures its roles. */
  ownerOnly: boolean;
  /** Granting, revoking or exercising this should be written to the audit log. */
  audit: boolean;
  /**
   * Capabilities this one is useless without. The role editor turns these on
   * automatically rather than letting an owner save a role that can adjust
   * stock it cannot see.
   */
  implies?: readonly Permission[];
}

const P = PERMISSIONS;

const GROUP_LABELS: Record<PermissionGroup, string> = {
  orders: "فروش و سفارش‌ها",
  payments: "پرداخت‌ها",
  floor: "سالن و تحویل",
  menu: "منو و کالا",
  inventory: "انبار و خرید",
  parties: "اشخاص",
  crm: "مشتریان و CRM",
  workspace: "میز کار",
  accounting: "حسابداری",
  reports: "گزارش‌ها",
  growth: "رشد و بازاریابی",
  website: "مدیریت وب‌سایت",
  data: "ورود و خروج داده",
  team: "تیم و دسترسی",
  settings: "تنظیمات و شعب",
  security: "امنیت و API",
};

export function permissionGroupLabel(group: PermissionGroup): string {
  return GROUP_LABELS[group];
}

export const PERMISSION_GROUP_ORDER: readonly PermissionGroup[] = [
  "orders", "payments", "floor", "menu", "inventory", "parties", "crm",
  "workspace", "accounting", "reports", "growth", "website", "data",
  "team", "settings", "security",
];

type Draft = Omit<PermissionMetadata, "ownerOnly" | "delegatable"> &
  Partial<Pick<PermissionMetadata, "delegatable">>;

const DRAFTS: Draft[] = [
  // --- Sales & orders ------------------------------------------------------
  { key: P.ordersCreate, group: "orders", label: "ثبت سفارش", description: "ایجاد سفارش جدید و افزودن اقلام به آن.", risk: "low", audit: false, implies: [P.menuView] },
  { key: P.ordersDiscount, group: "orders", label: "اعمال تخفیف", description: "کاهش مبلغ سفارش پیش از تسویه.", risk: "medium", audit: true, implies: [P.ordersCreate] },
  { key: P.ordersVoid, group: "orders", label: "ابطال سفارش باز", description: "حذف سفارشی که هنوز تسویه نشده است.", risk: "medium", audit: true },
  { key: P.ordersAmendClosed, group: "orders", label: "اصلاح سفارش بسته", description: "تغییر یا حذف سفارشی که پرداخت شده است؛ درآمد، مالیات، بهای تمام‌شده و موجودی را برمی‌گرداند.", risk: "high", audit: true, implies: [P.ordersVoid] },

  // --- Payments ------------------------------------------------------------
  { key: P.paymentsTake, group: "payments", label: "دریافت پرداخت", description: "تسویه سفارش با نقد، کارت یا سایر روش‌ها.", risk: "medium", audit: false },
  { key: P.paymentsRefund, group: "payments", label: "بازگشت وجه", description: "برگرداندن پول به مشتری. مستقیماً بر صندوق و دفاتر اثر دارد.", risk: "high", audit: true, implies: [P.paymentsTake] },

  // --- Floor ---------------------------------------------------------------
  { key: P.tablesManage, group: "floor", label: "مدیریت میزها", description: "باز و بسته کردن میز و جابه‌جایی سفارش بین میزها.", risk: "low", audit: false },
  { key: P.reservationsManage, group: "floor", label: "مدیریت رزرو", description: "ثبت، تغییر و لغو رزرو.", risk: "low", audit: false },
  { key: P.kitchenView, group: "floor", label: "نمایشگر آشپزخانه", description: "مشاهده و به‌روزرسانی وضعیت اقلام در آشپزخانه.", risk: "low", audit: false },
  { key: P.deliveryManage, group: "floor", label: "مدیریت ارسال", description: "تخصیص پیک و پیگیری وضعیت ارسال.", risk: "low", audit: false },

  // --- Catalogue -----------------------------------------------------------
  { key: P.menuView, group: "menu", label: "مشاهده منو", description: "دیدن کالاها، دسته‌ها و قیمت‌ها.", risk: "low", audit: false },
  { key: P.menuEdit, group: "menu", label: "ویرایش منو", description: "افزودن، تغییر و حذف کالا، دسته و قیمت.", risk: "medium", audit: true, implies: [P.menuView] },

  // --- Inventory -----------------------------------------------------------
  { key: P.inventoryView, group: "inventory", label: "مشاهده انبار", description: "دیدن موجودی، بهای تمام‌شده و گردش کالا.", risk: "low", audit: false },
  { key: P.inventoryAdjust, group: "inventory", label: "اصلاح موجودی", description: "ثبت مغایرت، ضایعات و شمارش انبار.", risk: "high", audit: true, implies: [P.inventoryView] },
  { key: P.purchasesManage, group: "inventory", label: "مدیریت خرید", description: "ثبت سفارش خرید و رسید کالا از تأمین‌کننده.", risk: "medium", audit: true, implies: [P.inventoryView] },

  // --- Parties -------------------------------------------------------------
  { key: P.partiesView, group: "parties", label: "مشاهده اشخاص", description: "دیدن پرونده مشتری، تأمین‌کننده و پرسنل.", risk: "low", audit: false },
  { key: P.partiesManage, group: "parties", label: "ویرایش اشخاص", description: "ایجاد و اصلاح پرونده اشخاص.", risk: "medium", audit: false, implies: [P.partiesView] },

  // --- CRM -----------------------------------------------------------------
  { key: P.crmView, group: "crm", label: "مشاهده CRM", description: "پرونده ۳۶۰ درجه، قیف فروش، بخش‌بندی و گزارش‌های CRM.", risk: "low", audit: false },
  { key: P.crmManage, group: "crm", label: "کار روزمره CRM", description: "یادداشت، وظیفه، فعالیت، پرونده پشتیبانی و معامله.", risk: "medium", audit: false },
  { key: P.crmMerge, group: "crm", label: "ادغام مشتریان", description: "ادغام دو پرونده مشتری. برگشت‌ناپذیر است و تاریخچه هر دو را بازنویسی می‌کند.", risk: "high", audit: true, implies: [P.crmView] },
  { key: P.crmConsentManage, group: "crm", label: "مدیریت رضایت بازاریابی", description: "تغییر رضایت مشتری برای دریافت پیام. یک سابقه حقوقی است.", risk: "high", audit: true },
  { key: P.crmExport, group: "crm", label: "خروجی گرفتن از مشتریان", description: "دانلود فهرست مشتریان. راهی است که یک بانک اطلاعاتی از سازمان خارج می‌شود.", risk: "high", audit: true, implies: [P.crmView] },
  { key: P.crmConfigure, group: "crm", label: "پیکربندی CRM", description: "تغییر مراحل قیف، تعریف بخش‌ها و ساختار گزارش‌ها.", risk: "medium", audit: true, implies: [P.crmView] },

  // --- Workspace -----------------------------------------------------------
  { key: P.workspaceView, group: "workspace", label: "مشاهده میز کار", description: "دیدن پروژه‌ها، وظایف و اسناد.", risk: "low", audit: false },
  { key: P.workspaceManage, group: "workspace", label: "مدیریت میز کار", description: "ایجاد و ویرایش پروژه، وظیفه، سند و تقویم.", risk: "medium", audit: false, implies: [P.workspaceView] },
  { key: P.workspaceContractsManage, group: "workspace", label: "مدیریت قراردادها", description: "ثبت و اصلاح قرارداد اجرا؛ یک تعهد مالی به شخص ثالث است.", risk: "high", audit: true, implies: [P.workspaceView] },
  { key: P.workspaceApprove, group: "workspace", label: "تأیید درخواست‌ها", description: "تصمیم‌گیری درباره درخواست‌های نیازمند تأیید.", risk: "high", audit: true, implies: [P.workspaceView] },

  // --- Accounting ----------------------------------------------------------
  { key: P.ledgerView, group: "accounting", label: "مشاهده دفاتر", description: "دیدن اسناد حسابداری، دفتر کل و صورت‌های مالی.", risk: "low", audit: false },
  { key: P.ledgerPost, group: "accounting", label: "ثبت سند", description: "ثبت سند حسابداری در دفاتر.", risk: "high", audit: true, implies: [P.ledgerView] },
  { key: P.ledgerApprove, group: "accounting", label: "تأیید سند", description: "تأیید سند ثبت‌شده. جدا از ثبت است تا تفکیک وظایف حفظ شود.", risk: "high", audit: true, implies: [P.ledgerView] },
  { key: P.ledgerClosePeriod, group: "accounting", label: "بستن دوره مالی", description: "بستن یا بازگشایی دوره مالی. پس از آن ثبت در دوره ممکن نیست.", risk: "critical", audit: true, implies: [P.ledgerView] },
  { key: P.accountsEdit, group: "accounting", label: "ویرایش کدینگ حساب‌ها", description: "تغییر ساختار حساب‌ها؛ هر گزارش تاریخی را بازتعریف می‌کند.", risk: "high", audit: true, implies: [P.ledgerView] },

  // --- Reports -------------------------------------------------------------
  { key: P.reportsView, group: "reports", label: "مشاهده گزارش‌ها", description: "دیدن گزارش‌های فروش، مالی و عملیاتی.", risk: "low", audit: false },
  { key: P.reportsExport, group: "reports", label: "خروجی گزارش", description: "دانلود گزارش‌ها به صورت فایل.", risk: "medium", audit: true, implies: [P.reportsView] },

  // --- Growth --------------------------------------------------------------
  { key: P.growthView, group: "growth", label: "مشاهده رشد", description: "صفحه مشتریان و گزارش‌های حسابداری رشد.", risk: "low", audit: false },
  { key: P.growthManage, group: "growth", label: "مدیریت رشد", description: "داشبورد رشد، اجرای کمپین، ارسال پیامک، پورسانت و تنظیمات برنامه.", risk: "high", audit: true, implies: [P.growthView] },
  { key: P.loyaltyView, group: "growth", label: "مشاهده باشگاه مشتریان", description: "مشاهده برنامه‌های وفاداری، امتیاز مشتری و یادآوری خرید مجدد.", risk: "low", audit: false },
  { key: P.loyaltyManage, group: "growth", label: "مدیریت باشگاه مشتریان", description: "تعریف برنامه وفاداری، استفاده از امتیاز و اعطای اعتبار فروشگاهی.", risk: "high", audit: true, implies: [P.loyaltyView] },

  // --- Website -------------------------------------------------------------
  { key: P.websiteView, group: "website", label: "مشاهده وب‌سایت", description: "دیدن وضعیت سایت، محتوا، محصولات و سفارش‌های آنلاین.", risk: "low", audit: false },
  { key: P.websiteManage, group: "website", label: "مدیریت محتوای وب‌سایت", description: "ویرایش پیش‌نویس‌ها، نوشته‌ها، محصولات، رسانه و سفارش‌ها.", risk: "medium", audit: false, implies: [P.websiteView] },
  { key: P.websitePublish, group: "website", label: "انتشار در وب‌سایت", description: "منتشر کردن پیش‌نویس روی سایت عمومی. بلافاصله برای همه قابل مشاهده می‌شود.", risk: "high", audit: true, implies: [P.websiteManage] },
  { key: P.websiteConfigure, group: "website", label: "پیکربندی وب‌سایت", description: "دامنه، DNS، CDN و راه‌اندازی سایت. می‌تواند سایت را از دسترس خارج کند.", risk: "critical", audit: true, implies: [P.websiteView] },

  // --- Data transfer -------------------------------------------------------
  { key: P.dataImport, group: "data", label: "ورود داده انبوه", description: "بارگذاری فایل برای ایجاد یا به‌روزرسانی انبوه رکوردها. همیشه با مجوز خودِ آن بخش ترکیب می‌شود.", risk: "high", audit: true },
  { key: P.dataExport, group: "data", label: "خروج داده انبوه", description: "دریافت خروجی انبوه. همیشه با مجوز خودِ آن بخش ترکیب می‌شود.", risk: "high", audit: true },

  // --- Team ----------------------------------------------------------------
  { key: P.teamView, group: "team", label: "مشاهده تیم", description: "دیدن فهرست همکاران، نقش و دسترسی آن‌ها بدون امکان تغییر.", risk: "low", audit: false },
  { key: P.teamManage, group: "team", label: "مدیریت تیم", description: "افزودن، تعلیق و پایان همکاری، بازنشانی رمز و PIN، دعوت‌نامه‌ها.", risk: "high", audit: true, implies: [P.teamView] },
  { key: P.teamPermissionsManage, group: "team", label: "مدیریت نقش و دسترسی", description: "تغییر نقش و مجوزهای فردی همکاران. راهی است که یک مدیر می‌تواند دسترسی خودش را گسترش دهد.", risk: "critical", audit: true, implies: [P.teamView] },

  // --- Settings & branches -------------------------------------------------
  { key: P.settingsManage, group: "settings", label: "مدیریت تنظیمات", description: "تنظیمات کسب‌وکار، مالیات، چاپ و پیکربندی عمومی.", risk: "medium", audit: true },
  { key: P.locationsManage, group: "settings", label: "مدیریت شعب", description: "ایجاد، ویرایش و غیرفعال کردن شعبه.", risk: "high", audit: true },
  { key: P.backupManage, group: "settings", label: "پشتیبان‌گیری و بازیابی", description: "گرفتن پشتیبان و بازگرداندن آن. بازیابی، داده‌های فعلی را جایگزین می‌کند.", risk: "critical", audit: true },

  // --- Security ------------------------------------------------------------
  { key: P.apiManage, group: "security", label: "مدیریت کلیدهای API", description: "ساخت و ابطال اعتبارنامه‌های بلندمدت برای سامانه‌های بیرونی.", risk: "critical", audit: true },
];

/**
 * `ownerOnly`/`delegatable` are derived from `OWNER_ONLY_PERMISSIONS` rather
 * than restated here, so the registry can never disagree with the code that
 * actually enforces them.
 */
export const PERMISSION_METADATA: Record<Permission, PermissionMetadata> = Object.fromEntries(
  DRAFTS.map((d) => {
    const ownerOnly = isOwnerOnlyPermission(d.key);
    return [d.key, { ...d, ownerOnly, delegatable: d.delegatable ?? !ownerOnly }];
  }),
) as Record<Permission, PermissionMetadata>;

export function permissionMetadata(key: Permission): PermissionMetadata {
  return PERMISSION_METADATA[key];
}

/** Every permission in a group, in catalogue order. */
export function permissionsInGroup(group: PermissionGroup): PermissionMetadata[] {
  return DRAFTS.filter((d) => d.group === group).map((d) => PERMISSION_METADATA[d.key]);
}

/**
 * The keys `selected` implies but does not contain — what the role editor must
 * switch on for the selection to mean anything. Resolved transitively, because
 * `orders.amend_closed` implies `orders.void` and the chain can be longer than
 * one step; a cycle (which would be a bug in the table above) terminates
 * because each key is visited once.
 */
export function impliedPermissions(selected: Iterable<Permission>): Permission[] {
  const result = new Set<Permission>();
  const seen = new Set<Permission>();
  const walk = (key: Permission) => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const implied of PERMISSION_METADATA[key]?.implies ?? []) {
      result.add(implied);
      walk(implied);
    }
  };
  for (const key of selected) walk(key);
  for (const key of selected) result.delete(key);
  return [...result];
}

/**
 * Permission search for the role editor: matches the key, the label, the
 * description and the group name, so «بازگشت وجه», "refund" and
 * "payments.refund" all find the same row.
 */
export function searchPermissions(term: string): PermissionMetadata[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return ALL_PERMISSIONS.map((k) => PERMISSION_METADATA[k]);
  return ALL_PERMISSIONS
    .map((k) => PERMISSION_METADATA[k])
    .filter((m) =>
      [m.key, m.label, m.description, m.group, GROUP_LABELS[m.group]]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
}

/** High-risk keys, for the role editor's warning treatment. */
export function isDangerousPermission(key: Permission): boolean {
  const risk = PERMISSION_METADATA[key]?.risk;
  return risk === "high" || risk === "critical";
}
