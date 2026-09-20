"use client";

/** CRM's own settings. Platform-wide settings intentionally stay under `/settings`. */

import Link from "next/link";
import { CopyCheckIcon, ShieldCheckIcon, TargetIcon, UsersIcon } from "lucide-react";
import { AppSettingsPanel, type AppSettingsGroup } from "@/components/app-settings/app-settings-panel";
import { PLATFORM_SETTINGS_HOME } from "@/lib/app-routes";
import { DEAL_STAGES, DEAL_STAGE_META } from "@/lib/crm-shared";
import { cardClass } from "@/app/dashboard/page-chrome";
import { crmSectionHref } from "./crm-routes";
import { AppSettingsShortcut } from "@/components/app-settings/app-settings-shortcut";

export function CrmSettingsSection() {
  const groups: AppSettingsGroup[] = [
    {
      key: "duplicates",
      label: "تشخیص اشخاص تکراری",
      description: "بازبینی پرونده‌های مشکوک به تکرار و ادغام دستی؛ هیچ پرونده‌ای خودکار حذف نمی‌شود.",
      icon: CopyCheckIcon,
      body: (
        <AppSettingsShortcut
          href={crmSectionHref("duplicates")}
          label="باز کردن اشخاص تکراری"
          description="پیش از ادغام، سابقه، رضایت و اطلاعاتی که منتقل می‌شود را می‌بینید."
        />
      ),
    },
    {
      key: "consent",
      label: "رضایت ارتباط",
      description: "سابقهٔ اجازهٔ پیامک و ایمیل؛ منبع حقیقت ارسال در برنامهٔ رشد است.",
      icon: ShieldCheckIcon,
      body: (
        <AppSettingsShortcut
          href={crmSectionHref("consent")}
          label="باز کردن رضایت ارتباط"
          description="گزارش پوشش رضایت و دفتر ثبت تغییرات را ببینید؛ تغییر رضایت کنار پروندهٔ مشتری انجام می‌شود."
        />
      ),
    },
    {
      key: "pipeline",
      label: "مراحل قیف فروش",
      description: "مراحل ثابت قیف برای همهٔ معامله‌ها. احتمال هر مرحله هنگام ساخت معامله قابل ویرایش است.",
      icon: TargetIcon,
      body: <PipelineStages />,
    },
    {
      key: "ownership",
      label: "مالکیت و پیگیری پرونده‌ها",
      description: "مالک معامله یا کار در همان فرم انتخاب می‌شود؛ نقش و اعضای تیم از تنظیمات پلتفرم می‌آید.",
      icon: UsersIcon,
      body: (
        <div className="grid gap-3 sm:grid-cols-2">
          <AppSettingsShortcut
            href={crmSectionHref("deals")}
            label="مدیریت مالک معامله‌ها"
            description="در فرم هر معامله، عضو مسئول را انتخاب یا تغییر دهید."
          />
          <AppSettingsShortcut
            href={crmSectionHref("activities")}
            label="مدیریت کارهای پیگیری"
            description="کارها را به عضو تیم واگذار کنید و وضعیت انجام را پیگیری کنید."
          />
        </div>
      ),
    },
  ];

  return (
    <AppSettingsPanel
      groups={groups}
      navigationLabel="دسترسی سریع تنظیمات ارتباط با مشتری"
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

function PipelineStages() {
  return (
    <div className="space-y-3">
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {DEAL_STAGES.map((stage, index) => {
          const meta = DEAL_STAGE_META[stage];
          return (
            <li key={stage} className={`${cardClass} min-w-0 p-3`}>
              <div className="flex items-start gap-2">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xs font-bold text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="font-semibold text-foreground">{meta.label}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{meta.description}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    احتمال پیش‌فرض: <span className="font-semibold text-foreground">{meta.probability}٪</span>
                  </p>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <Link
        href={crmSectionHref("deals")}
        className="inline-flex min-h-10 items-center rounded-lg px-2 text-sm font-semibold text-amber-800 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 dark:text-amber-300"
      >
        رفتن به قیف فروش
      </Link>
    </div>
  );
}
