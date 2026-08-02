import type { Role } from "./auth";
import { PERMISSIONS, type Permission } from "./permissions";

export const SETTINGS_TAB_KEYS = [
  "business",
  "tax",
  "pricing",
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
}

export interface SettingsTabVisibilityOptions {
  role?: Role;
  features?: Record<string, boolean>;
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
  },
  {
    key: "pricing",
    label: "قیمت‌گذاری",
    description: "هدف حاشیه سود پیش‌فرض برای پیشنهاد قیمت آیتم‌های منو",
    requiredAnyPermission: [PERMISSIONS.settingsManage],
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
    description: "نشست‌های فعال کارکنان و تلاش‌های ورود ناموفق، با امکان پایان‌دادن به یک نشست",
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
  return SETTINGS_TABS.filter((tab) => {
    if (tab.requiredAnyPermission && !tab.requiredAnyPermission.some((permission) => granted.has(permission))) {
      return false;
    }
    if (tab.allowedRoles && (!options.role || !tab.allowedRoles.includes(options.role))) return false;
    if (tab.feature && !options.features?.[tab.feature]) return false;
    if (tab.requiredAnyFeature && !tab.requiredAnyFeature.some((feature) => options.features?.[feature])) return false;
    return true;
  });
}

export function isSettingsTabKey(value: string | null): value is SettingsTabKey {
  return value !== null && (SETTINGS_TAB_KEYS as readonly string[]).includes(value);
}
