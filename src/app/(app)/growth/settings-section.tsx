"use client";

/**
 * Growth → «تنظیمات رشد و بازاریابی» — the Growth app's settings home.
 *
 * The first version was four static «به‌زودی» cards. That was a dead end:
 * loyalty rules, campaigns, messaging and commission already have real owner
 * screens, yet this page neither reported their state nor took the owner to
 * them. It also implied that sender configuration lived in Growth, while the
 * provider credentials and message-credit account are platform-owned.
 *
 * This page therefore reports the real, read-only state of the four Growth
 * engines and links each fact to its single owning editor. It deliberately
 * does not duplicate those editors: a second loyalty/program or campaign form
 * here would be two mutation surfaces over the same records.
 */

import { useCallback, useEffect, useState } from "react";
import {
  HandCoinsIcon,
  HeartIcon,
  MegaphoneIcon,
  MessageCircleIcon,
} from "lucide-react";
import {
  AppSettingsPanel,
  type AppSettingsGroup,
} from "@/components/app-settings/app-settings-panel";
import { AppSettingsShortcut } from "@/components/app-settings/app-settings-shortcut";
import { PLATFORM_BILLING_HREF, PLATFORM_SUBSCRIPTION_HREF } from "@/lib/app-routes";
import { crmSectionHref } from "@/app/(app)/crm/crm-routes";
import { SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessageOrRaw, SecondaryButton } from "@/app/dashboard/ui";
import { formatPersianNumber } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { growthSectionHref } from "./growth-routes";

interface GrowthSettings {
  loyalty: {
    programCount: number;
    activeProgramCount: number;
    defaultProgram: {
      name: string;
      earnPointsPer100000: number;
      pointValueRial: number;
      pointsExpiryDays: number | null;
    } | null;
  };
  campaigns: {
    total: number;
    live: number;
    scheduled: number;
    paused: number;
    ended: number;
  };
  messaging: {
    templateCount: number;
    smsTemplateCount: number;
    emailTemplateCount: number;
    enabled: boolean;
    configured: boolean;
  };
  commission: {
    ruleCount: number;
    activeRuleCount: number;
    staffWithActiveRules: number;
  };
}

/** A compact fact that wraps gracefully instead of making a four-column phone grid. */
function SettingFact({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "active" | "positive" | "neutral" | "danger";
  hint?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border/80 bg-stone-50/60 p-3 dark:bg-stone-800/30">
      <p className="text-xs leading-5 text-muted-foreground">{label}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {tone ? (
          <StatusBadge tone={tone}>{value}</StatusBadge>
        ) : (
          <p className="min-w-0 break-words text-sm font-semibold text-foreground">{value}</p>
        )}
      </div>
      {hint ? <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function GrowthSettingsSection() {
  const money = useMoney();
  const [settings, setSettings] = useState<GrowthSettings | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    void api<{ settings: GrowthSettings; error?: string }>("/api/growth/settings").then(({ ok, data }) => {
      if (ok) setSettings(data.settings);
      else setError(data.error ? errorMessageOrRaw(data.error) : "بارگذاری تنظیمات رشد و بازاریابی ناموفق بود.");
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div className="space-y-3">
        <ErrorBox>{error}</ErrorBox>
        <div className="max-w-xs">
          <SecondaryButton onClick={load}>تلاش دوباره</SecondaryButton>
        </div>
      </div>
    );
  }

  if (!settings) {
    return <SectionCardSkeleton rows={4} label="در حال بارگذاری تنظیمات رشد و بازاریابی" />;
  }

  const { loyalty, campaigns, messaging, commission } = settings;
  const defaultProgram = loyalty.defaultProgram;
  const groups: AppSettingsGroup[] = [
    {
      key: "loyalty",
      label: "قواعد وفاداری",
      description: "طرح پیش‌فرض، نرخ امتیازدهی و انقضای امتیازها.",
      icon: HeartIcon,
      body: (
        <div className="space-y-4">
          {defaultProgram ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <SettingFact label="طرح‌های فعال" value={formatPersianNumber(loyalty.activeProgramCount)} />
              <SettingFact label="طرح پیش‌فرض" value={defaultProgram.name} />
              <SettingFact
                label={`امتیاز به‌ازای ۱۰۰٬۰۰۰ ${money.unitLabel}`}
                value={formatPersianNumber(defaultProgram.earnPointsPer100000)}
              />
              <SettingFact label="ارزش هر امتیاز" value={money.format(defaultProgram.pointValueRial)} />
              <SettingFact
                label="انقضای امتیاز"
                value={
                  defaultProgram.pointsExpiryDays === null
                    ? "بدون انقضا"
                    : `${formatPersianNumber(defaultProgram.pointsExpiryDays)} روز`
                }
              />
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-amber-300/70 bg-amber-50/60 px-3 py-4 text-sm leading-6 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              {loyalty.activeProgramCount > 0
                ? "یک طرح وفاداری فعال دارید، اما هیچ‌کدام پیش‌فرض نیست. تا زمانی که طرح پیش‌فرض تعیین نشود، نرخ امتیازدهی فروش‌ها روشن نیست."
                : "هنوز برنامهٔ وفاداری فعالی تعریف نشده است؛ تا قبل از تعریف آن، خریدها امتیاز نمی‌گیرند."}
            </p>
          )}
          <AppSettingsShortcut
            href={growthSectionHref("loyalty")}
            label="مدیریت برنامهٔ وفاداری"
            description={`${formatPersianNumber(loyalty.programCount)} طرح ثبت شده است؛ افزودن و تغییر طرح‌ها در صفحهٔ «وفاداری و اعتبار» انجام می‌شود.`}
          />
        </div>
      ),
    },
    {
      key: "campaigns",
      label: "کمپین‌ها و تخفیف‌ها",
      description: "وضعیت اجرا، زمان‌بندی و قانون هم‌پوشانی تخفیف‌ها.",
      icon: MegaphoneIcon,
      body: (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SettingFact label="همهٔ کمپین‌ها" value={formatPersianNumber(campaigns.total)} />
            <SettingFact label="در حال اجرا" value={formatPersianNumber(campaigns.live)} tone="positive" />
            <SettingFact label="زمان‌بندی‌شده" value={formatPersianNumber(campaigns.scheduled)} tone="active" />
            <SettingFact
              label="متوقف / پایان‌یافته"
              value={`${formatPersianNumber(campaigns.paused)} / ${formatPersianNumber(campaigns.ended)}`}
              tone={campaigns.paused > 0 ? "neutral" : undefined}
            />
          </div>
          <AppSettingsShortcut
            href={growthSectionHref("campaigns")}
            label="مدیریت کمپین‌ها"
            description="قانون تخفیف، بازهٔ اجرا، اولویت و ترکیب‌پذیری هر کمپین در صفحهٔ «کمپین‌ها» تنظیم می‌شود."
          />
        </div>
      ),
    },
    {
      key: "messaging",
      label: "پیام‌رسانی",
      description: "الگوهای پیام، رضایت ارتباط و آمادگی سرویس ارسال.",
      icon: MessageCircleIcon,
      body: (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <SettingFact
              label="وضعیت سرویس ارسال"
              value={
                messaging.enabled && messaging.configured
                  ? "آمادهٔ ارسال"
                  : messaging.enabled
                    ? "نیازمند تکمیل تنظیم پلتفرم"
                    : "غیرفعال در پلتفرم"
              }
              tone={messaging.enabled && messaging.configured ? "positive" : "danger"}
              hint={
                messaging.enabled && messaging.configured
                  ? "ارسال همچنان فقط به مشتریانِ دارای رضایت انجام می‌شود."
                  : "کلید و فرستندهٔ پیامک یا ایمیل، تنظیم فنی پلتفرم است."
              }
            />
            <SettingFact label="الگوهای پیامک" value={formatPersianNumber(messaging.smsTemplateCount)} />
            <SettingFact label="الگوهای ایمیل" value={formatPersianNumber(messaging.emailTemplateCount)} />
          </div>
          <div className="space-y-3">
            <AppSettingsShortcut
              href={growthSectionHref("messaging")}
              label="مدیریت الگو و کمپین پیام"
              description={`${formatPersianNumber(messaging.templateCount)} الگو ثبت شده است؛ ساخت الگو، پیش‌نمایش مخاطب و صف ارسال در همین برنامه انجام می‌شود.`}
            />
            <AppSettingsShortcut
              href={crmSectionHref("consent")}
              label="مدیریت رضایت ارتباط (CRM)"
              description="رضایت پیامک و ایمیل در برنامهٔ «ارتباط با مشتری» نگهداری می‌شود؛ این پیوند آن برنامه را باز می‌کند."
            />
          </div>
        </div>
      ),
    },
    {
      key: "commission",
      label: "قواعد پورسانت",
      description: "قاعده‌های فعال، فروشندگان مشمول و مبنای محاسبهٔ پورسانت.",
      icon: HandCoinsIcon,
      body: (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <SettingFact label="همهٔ قاعده‌ها" value={formatPersianNumber(commission.ruleCount)} />
            <SettingFact label="قاعده‌های فعال" value={formatPersianNumber(commission.activeRuleCount)} tone="positive" />
            <SettingFact label="فروشندگان مشمول" value={formatPersianNumber(commission.staffWithActiveRules)} />
          </div>
          <AppSettingsShortcut
            href={growthSectionHref("commission")}
            label="مدیریت قواعد پورسانت"
            description="درصد یا مبلغ ثابت، مبنای فروش یا سود، و اولویت هر قاعده در صفحهٔ «پورسانت فروشندگان» تنظیم می‌شود."
          />
        </div>
      ),
    },
  ];

  return (
    <AppSettingsPanel
      groups={groups}
      platformNote="اعتبار پیام و اشتراک، و همچنین اتصال فنیِ سرویس پیامک و ایمیل، متعلق به پلتفرم است — نه برنامهٔ رشد و بازاریابی."
      platformLinks={[
        {
          label: "اعتبار و صورت‌حساب پلتفرم",
          description: "شارژ اعتبار پیامک و ایمیل و تاریخچهٔ پرداخت‌ها در تنظیمات پلتفرم.",
          href: PLATFORM_BILLING_HREF,
        },
        {
          label: "اشتراک پلتفرم",
          description: "پلن فعلی کسب‌وکار و دسترسی‌های آن در تنظیمات پلتفرم.",
          href: PLATFORM_SUBSCRIPTION_HREF,
        },
      ]}
    />
  );
}
