"use client";

/**
 * CRM → «تنظیمات ارتباط با مشتری» — the CRM app's *own* settings.
 *
 * Not the platform settings page: `/settings` configures the business,
 * `/crm/settings` configures how this app keeps the customer record — how
 * duplicates are matched, what consent it assumes, what the pipeline's stages
 * are. Team membership and security are platform matters and are linked as
 * such rather than reproduced here.
 */

import { CopyCheckIcon, ShieldCheckIcon, TargetIcon, UsersIcon } from "lucide-react";
import {
  AppSettingsPanel,
  type AppSettingsGroup,
} from "@/components/app-settings/app-settings-panel";
import { PLATFORM_SETTINGS_HOME } from "@/lib/app-routes";
import { crmSectionHref } from "./crm-routes";
import { CrmSettingsShortcut } from "./settings-shortcuts";

export function CrmSettingsSection() {
  const groups: AppSettingsGroup[] = [
    {
      key: "duplicates",
      label: "تشخیص اشخاص تکراری",
      description: "بر پایهٔ شمارهٔ تلفن و نام، با ادغام دستی.",
      icon: CopyCheckIcon,
      body: (
        <CrmSettingsShortcut
          href={crmSectionHref("duplicates")}
          label="باز کردن اشخاص تکراری"
          description="پرونده‌های مشکوک به تکرار و ادغام آن‌ها در صفحهٔ خودشان انجام می‌شود."
        />
      ),
    },
    {
      key: "consent",
      label: "رضایت ارتباط",
      description: "سابقهٔ اجازهٔ پیامک و ایمیل هر مشتری — منبع حقیقتِ ارسال در برنامهٔ رشد.",
      icon: ShieldCheckIcon,
      body: (
        <CrmSettingsShortcut
          href={crmSectionHref("consent")}
          label="باز کردن رضایت ارتباط"
          description="ثبت و بازبینی رضایت هر مشتری در صفحهٔ «رضایت ارتباط» انجام می‌شود."
        />
      ),
    },
    {
      key: "pipeline",
      label: "مراحل قیف فروش",
      description: "نام و ترتیب مراحل معامله‌ها.",
      icon: TargetIcon,
      comingSoon: "ویرایش مراحل قیف فروش به‌زودی اضافه می‌شود؛ فعلاً مراحل پیش‌فرض اعمال می‌شود.",
    },
    {
      key: "ownership",
      label: "مالکیت پرونده‌ها",
      description: "اینکه پروندهٔ هر مشتری به کدام عضو تیم واگذار شود.",
      icon: UsersIcon,
      comingSoon:
        "واگذاری خودکار پرونده‌ها هنوز آماده نشده است؛ اعضای تیم در تنظیمات پلتفرم تعریف می‌شوند.",
    },
  ];

  return (
    <AppSettingsPanel
      groups={groups}
      platformNote="اعضای تیم و دسترسی‌ها متعلق به پلتفرم است، نه برنامهٔ ارتباط با مشتری."
      platformLinks={[
        {
          label: "اعضای تیم (تنظیمات پلتفرم)",
          description: "افزودن عضو و تعیین نقش‌ها در تنظیمات پلتفرم انجام می‌شود.",
          href: "/settings/team",
        },
        {
          label: "تنظیمات پلتفرم",
          description: "تنظیمات کسب‌وکار، امنیت و اعلان‌ها.",
          href: PLATFORM_SETTINGS_HOME,
        },
      ]}
    />
  );
}
