"use client";

/**
 * Accounting → «تنظیمات حسابداری» — the Accounting app's *own* settings.
 *
 * Emphatically not the platform settings page: `/settings` configures the
 * business (printers, tax rates, devices, team), `/accounting/settings`
 * configures the ledger. The two used to be the same screen reached from two
 * menus, which is how an accountant opening "settings" from inside Accounting
 * ended up on the till's payment methods.
 *
 * Billing and subscription stay platform-owned, and Accounting is allowed to
 * link to them — but the destination is labelled as platform billing rather
 * than dressed up as a section of this app.
 */

import { BookOpenIcon, CalendarRangeIcon, PercentIcon, UsersIcon } from "lucide-react";
import {
  AppSettingsPanel,
  type AppSettingsGroup,
} from "@/components/app-settings/app-settings-panel";
import { PLATFORM_BILLING_HREF, PLATFORM_SUBSCRIPTION_HREF } from "@/lib/app-routes";
import { ChartOfAccountsShortcut } from "./settings-shortcuts";
import { accountingSectionHref } from "./accounting-routes";

export function AccountingSettingsSection() {
  const groups: AppSettingsGroup[] = [
    {
      key: "chart-of-accounts",
      label: "سرفصل حساب‌ها",
      description: "ساختار حساب‌های دفتر کل — افزودن، ویرایش و غیرفعال کردن حساب‌ها.",
      icon: BookOpenIcon,
      body: (
        <ChartOfAccountsShortcut
          href={accountingSectionHref("chart-of-accounts")}
          label="باز کردن سرفصل حساب‌ها"
          description="سرفصل‌ها صفحهٔ کامل خودشان را دارند؛ ویرایش آن‌ها همان‌جا انجام می‌شود."
        />
      ),
    },
    {
      key: "fiscal-periods",
      label: "سال و دوره‌های مالی",
      description: "تعریف سال مالی، بستن موقت و قفل کردن دوره‌ها.",
      icon: CalendarRangeIcon,
      body: (
        <ChartOfAccountsShortcut
          href={accountingSectionHref("fiscal-periods")}
          label="باز کردن دوره‌های مالی"
          description="وضعیت هر دوره (باز، بستهٔ موقت، قفل) در همان صفحه مدیریت می‌شود."
        />
      ),
    },
    {
      key: "vat",
      label: "قواعد مالیاتی دفتر",
      description: "نرخ پیش‌فرض مالیات بر ارزش افزوده و حساب‌های مالیاتی این دفتر.",
      icon: PercentIcon,
      comingSoon:
        "تنظیم نرخ‌های مالیاتی مخصوص دفتر هنوز آماده نشده است. تا آن زمان نرخ مالیات کسب‌وکار در تنظیمات پلتفرم تعریف می‌شود و همین دفتر از آن استفاده می‌کند.",
    },
    {
      key: "posting",
      label: "قواعد سندزنی خودکار",
      description: "اینکه فروش، خرید و حقوق با چه حساب‌هایی سند بخورند.",
      icon: UsersIcon,
      comingSoon:
        "ویرایش قواعد سندزنی خودکار به‌زودی اضافه می‌شود؛ فعلاً قواعد پیش‌فرض صنف کسب‌وکار اعمال می‌شود.",
    },
  ];

  return (
    <AppSettingsPanel
      groups={groups}
      platformNote="صورت‌حساب و اشتراک متعلق به پلتفرم است، نه برنامهٔ حسابداری؛ این پیوندها شما را به تنظیمات پلتفرم می‌برند."
      platformLinks={[
        {
          label: "صورت‌حساب و اعتبار پلتفرم",
          description: "شارژ اعتبار و تاریخچهٔ پرداخت‌ها در تنظیمات پلتفرم.",
          href: PLATFORM_BILLING_HREF,
        },
        {
          label: "اشتراک پلتفرم",
          description: "پلن فعلی و ارتقای اشتراک در تنظیمات پلتفرم.",
          href: PLATFORM_SUBSCRIPTION_HREF,
        },
      ]}
    />
  );
}
