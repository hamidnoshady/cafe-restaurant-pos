import type { Role } from "./auth";
import type { Industry } from "./industries";
import { hasModule, labelFor, type ModuleKey } from "./industry-profile";
import { PERMISSIONS, type Permission } from "./permissions";

export const SETTINGS_TAB_KEYS = [
  "business",
  "tax",
  "pricing",
  "online-platforms",
  "accounts",
  "team",
  "menu",
  "printers",
  "branch-management",
  "server-sync",
  "devices",
  "shifts",
  "audit-log",
  "security-center",
  "backup",
] as const;

export type SettingsTabKey = (typeof SETTINGS_TAB_KEYS)[number];

export interface SettingsTab {
  key: SettingsTabKey;
  label: string;
  description: string;
  requiredAnyPermission?: Permission[];
  allowedRoles?: Role[];
  feature?: string;
  /** Show when at least one of these feature flags is enabled. */
  requiredAnyFeature?: string[];
  /**
   * Phase 25 — the industry module this tab belongs to. A tab naming a module
   * the business's trade does not have is dropped entirely, the same way its
   * nav entry and its API route are.
   */
  module?: ModuleKey;
  /**
   * Rewrites the tab's label/description for a given industry. Only used where
   * the F&B wording would be actively wrong — «نرخ هر دسته از منو» in a
   * jewellery shop — not as a general translation table.
   */
  industryText?: (industry: Industry) => { label?: string; description?: string };
}

export interface SettingsTabVisibilityOptions {
  role?: Role;
  features?: Record<string, boolean>;
  /** Omitted by callers with no business in hand; then no module or wording filtering applies. */
  industry?: Industry;
}

export const SETTINGS_TABS: SettingsTab[] = [
  {
    key: "business",
    label: "کسب‌وکار و شعبه",
    description: "اطلاعات تماس، واحد پول و اطلاعات رسید",
    requiredAnyPermission: [PERMISSIONS.settingsManage],
  },
  {
    key: "tax",
    label: "مالیات",
    description: "نرخ پیش‌فرض و نرخ هر دسته از منو",
    requiredAnyPermission: [PERMISSIONS.settingsManage],
    // Per-category rates are a menu concept; a retail business only has the
    // default rate here, so promising "هر دسته از منو" would be a lie.
    industryText: (industry) =>
      hasModule(industry, "menu") ? {} : { description: "نرخ پیش‌فرض مالیات بر ارزش افزوده" },
  },
  {
    key: "pricing",
    label: "قیمت‌گذاری",
    description: "هدف حاشیه سود پیش‌فرض برای پیشنهاد قیمت آیتم‌های منو",
    requiredAnyPermission: [PERMISSIONS.settingsManage],
    industryText: (industry) => ({
      description: `هدف حاشیه سود پیش‌فرض برای پیشنهاد قیمت ${labelFor(industry, "catalogueItem")}‌ها`,
    }),
  },
  {
    key: "online-platforms",
    label: "پلتفرم‌های سفارش آنلاین",
    description: "نرخ کارمزد اسنپ‌فود، برای ثبت خودکار هنگام تسویه سفارش",
    requiredAnyPermission: [PERMISSIONS.settingsManage],
    // SnapFood is food delivery; the commission account and the whole tab are
    // meaningless outside F&B.
    module: "delivery",
  },
  {
    key: "accounts",
    label: "سرفصل حساب‌ها",
    description: "ساختار حساب‌های مالی کسب‌وکار",
    requiredAnyPermission: [PERMISSIONS.accountsEdit],
  },
  {
    key: "team",
    label: "کاربران و دسترسی‌ها",
    description: "اعضا، دعوت‌ها و مجوزهای اختصاصی",
    requiredAnyPermission: [PERMISSIONS.teamManage],
  },
  {
    key: "menu",
    label: "منو و ورود فایل",
    description: "مدیریت منو و ورود گروهی از CSV یا Excel",
    requiredAnyPermission: [PERMISSIONS.settingsManage],
    // `menu_items` is the F&B catalogue; the retail industries keep theirs on
    // Phase 21's `items` model, managed from their own dashboard page.
    module: "menu",
  },
  {
    key: "printers",
    label: "چاپگر و کشوی پول",
    description: "چاپگرهای شعبه، مسیر چاپ و آزمایش اتصال",
    requiredAnyPermission: [PERMISSIONS.settingsManage],
  },
  {
    key: "branch-management",
    label: "مدیریت شعب",
    description: "مدیریت شعب کسب‌وکار و همگام‌سازی داده‌های شعب با سرور مرکزی",
    allowedRoles: ["owner"],
    requiredAnyFeature: ["multi_location", "offline_mode"],
  },
  {
    key: "server-sync",
    label: "همگام‌سازی با سرور راه دور",
    description: "اتصال دوطرفه با سرور مرکزی (VPS)، وضعیت و رویدادهای ناموفق",
    allowedRoles: ["owner"],
    feature: "offline_mode",
  },
  {
    key: "devices",
    label: "دستگاه‌های ثبت‌شده",
    description: "پایانه‌های متصل و ورود بیومتریک اختصاصی هر دستگاه",
    requiredAnyPermission: [PERMISSIONS.settingsManage],
  },
  {
    key: "shifts",
    label: "شیفت‌ها",
    description: "تاریخچهٔ ورود/خروج کارکنان و تطبیق صندوق هر شیفت",
    requiredAnyPermission: [PERMISSIONS.teamManage],
  },
  {
    key: "audit-log",
    label: "گزارش حسابرسی",
    description: "رویدادهای امنیتی کسب‌وکار: ورود، تغییر اعتبارنامه، دستگاه و شیفت",
    requiredAnyPermission: [PERMISSIONS.teamManage],
  },
  {
    key: "security-center",
    label: "مرکز امنیت",
    description:
      "نشست‌های فعال، تلاش‌های ورود ناموفق و کارمندان قفل‌شده، با امکان پایان‌دادن به نشست یا رفع قفل",
    requiredAnyPermission: [PERMISSIONS.teamManage],
  },
  {
    key: "backup",
    label: "پشتیبان‌گیری",
    description: "وضعیت، اجرای دستی و زمان‌بندی پشتیبان‌گیری",
    allowedRoles: ["owner", "manager"],
    feature: "backup",
  },
];

export function visibleSettingsTabs(
  permissions: Iterable<Permission | string>,
  options: SettingsTabVisibilityOptions = {},
): SettingsTab[] {
  const granted = new Set(permissions);
  const industry = options.industry;
  return SETTINGS_TABS.filter((tab) => {
    if (tab.requiredAnyPermission && !tab.requiredAnyPermission.some((permission) => granted.has(permission))) {
      return false;
    }
    if (tab.allowedRoles && (!options.role || !tab.allowedRoles.includes(options.role))) return false;
    if (tab.feature && !options.features?.[tab.feature]) return false;
    if (tab.requiredAnyFeature && !tab.requiredAnyFeature.some((feature) => options.features?.[feature])) return false;
    if (tab.module && industry && !hasModule(industry, tab.module)) return false;
    return true;
  }).map((tab) => {
    // Rewrite wording only once the industry is known; a caller without one
    // (a test, a context with no business) keeps the F&B defaults it always had.
    const text = industry && tab.industryText ? tab.industryText(industry) : null;
    return text && (text.label || text.description)
      ? { ...tab, label: text.label ?? tab.label, description: text.description ?? tab.description }
      : tab;
  });
}

export function isSettingsTabKey(value: string | null): value is SettingsTabKey {
  return value !== null && (SETTINGS_TAB_KEYS as readonly string[]).includes(value);
}
