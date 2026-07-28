import { PERMISSIONS, type Permission } from "./permissions";

export const SETTINGS_TAB_KEYS = [
  "business",
  "tax",
  "pricing",
  "accounts",
  "team",
  "menu",
  "printers",
] as const;

export type SettingsTabKey = (typeof SETTINGS_TAB_KEYS)[number];

export interface SettingsTab {
  key: SettingsTabKey;
  label: string;
  description: string;
  requiredAnyPermission: Permission[];
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
];

export function visibleSettingsTabs(permissions: Iterable<Permission | string>): SettingsTab[] {
  const granted = new Set(permissions);
  return SETTINGS_TABS.filter((tab) => tab.requiredAnyPermission.some((permission) => granted.has(permission)));
}

export function isSettingsTabKey(value: string | null): value is SettingsTabKey {
  return value !== null && (SETTINGS_TAB_KEYS as readonly string[]).includes(value);
}
