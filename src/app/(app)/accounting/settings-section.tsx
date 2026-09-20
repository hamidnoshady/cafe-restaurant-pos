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
 * What this screen was, and why it changed: four static cards — two links and
 * two «به‌زودی» placeholders — that could not answer a single question about
 * how this ledger is configured. The VAT rate it said was "defined in platform
 * settings" was never shown; the posting rules it called "the trade's
 * defaults" were never named; whether a fiscal year existed at all — the thing
 * that decides if a period can be closed — was a different page away. Every
 * one of those facts was already in the database.
 *
 * So the page reports the real configuration (`/api/ledger/settings`) and
 * links to whoever owns each setting. It stays **read-only** deliberately: the
 * chart of accounts and the fiscal periods own full screens of their own, the
 * business VAT rate is platform-owned and shared with the till, and the
 * posting rules are structural (auto-posting resolves accounts by code, and
 * the chart guards those codes as well-known). Editing here would fork a
 * second editor over each one.
 *
 * Billing and subscription stay platform-owned, and Accounting is allowed to
 * link to them — but the destination is labelled as platform billing rather
 * than dressed up as a section of this app.
 */

import { useCallback, useEffect, useState } from "react";
import {
  BookOpenIcon,
  CalendarRangeIcon,
  PercentIcon,
  WorkflowIcon,
} from "lucide-react";
import {
  AppSettingsPanel,
  type AppSettingsGroup,
} from "@/components/app-settings/app-settings-panel";
import { AppSettingsShortcut } from "@/components/app-settings/app-settings-shortcut";
import { PLATFORM_BILLING_HREF, PLATFORM_SUBSCRIPTION_HREF } from "@/lib/app-routes";
import { api, ErrorBox, SecondaryButton } from "@/app/dashboard/ui";
import { SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import type { PostingRuleSummary } from "@/lib/accounting-posting-rules";
import { accountingSectionHref } from "./accounting-routes";

interface AccountingSettings {
  industry: string;
  industryLabel: string;
  vatRate: number | null;
  inventorySystem: "perpetual" | "periodic";
  costingMethod: "fifo" | "lifo" | "weighted_average" | null;
  accounts: { total: number; active: number; archived: number };
  fiscal: {
    yearCount: number;
    currentYearLabel: string | null;
    openPeriods: number;
    softClosedPeriods: number;
    lockedPeriods: number;
  };
  postingRules: PostingRuleSummary[];
}

const COSTING_LABELS: Record<string, string> = {
  fifo: "اولین صادره از اولین وارده (FIFO)",
  lifo: "اولین صادره از آخرین وارده (LIFO)",
  weighted_average: "میانگین موزون",
};

const INVENTORY_SYSTEM_LABELS: Record<string, string> = {
  perpetual: "دائمی",
  periodic: "ادواری",
};

/** A labelled fact, the shape the whole page states its configuration in. */
function Fact({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  /** Set when the value is a state worth colouring — «تعریف نشده» above all. */
  tone?: "active" | "positive" | "neutral" | "danger";
  hint?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border/80 bg-muted/60 p-3">
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

/**
 * One posting rule, as a debit/credit pair.
 *
 * A table would be the obvious shape and the wrong one: at 360px a four-column
 * table of Persian account names either scrolls sideways or wraps into
 * unreadable columns. These are stacked rows that stay legible at any width,
 * with the debit/credit side carried by a badge and a word rather than by
 * column position alone.
 */
function PostingRuleCard({ rule }: { rule: PostingRuleSummary }) {
  return (
    <div className="min-w-0 rounded-xl border border-border/80 p-3 sm:p-4">
      <p className="text-sm font-semibold text-foreground">{rule.label}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{rule.description}</p>
      <ul className="mt-3 space-y-2">
        {rule.lines.map((line, index) => (
          <li
            key={`${line.side}-${line.code}-${index}`}
            className="flex flex-wrap items-start gap-x-2 gap-y-1 rounded-lg bg-muted/60 px-3 py-2"
          >
            <StatusBadge tone={line.side === "debit" ? "active" : "neutral"}>
              {line.side === "debit" ? "بدهکار" : "بستانکار"}
            </StatusBadge>
            <span className="min-w-0 flex-1 text-sm text-foreground">
              {line.label}
              <span className="ms-1.5 font-mono text-xs text-muted-foreground" dir="ltr">
                {toPersianDigits(line.code)}
              </span>
            </span>
            {line.note ? (
              <span className="w-full text-xs leading-5 text-muted-foreground">{line.note}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AccountingSettingsSection() {
  const [settings, setSettings] = useState<AccountingSettings | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    api<{ settings: AccountingSettings }>("/api/ledger/settings").then(({ ok, data }) => {
      // Without this the page sat on a skeleton for ever whenever the read
      // failed — indistinguishable from a slow network, and with no way back.
      if (ok) setSettings(data.settings);
      else setError("بارگذاری تنظیمات حسابداری ناموفق بود.");
    });
  }, []);

  useEffect(load, [load]);

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

  if (!settings) return <SectionCardSkeleton rows={4} label="در حال بارگذاری تنظیمات حسابداری" />;

  const { accounts, fiscal } = settings;
  const periodTotal = fiscal.openPeriods + fiscal.softClosedPeriods + fiscal.lockedPeriods;

  const groups: AppSettingsGroup[] = [
    {
      key: "chart-of-accounts",
      label: "سرفصل حساب‌ها",
      description: "ساختار حساب‌های دفتر کل — افزودن، ویرایش و غیرفعال کردن حساب‌ها.",
      icon: BookOpenIcon,
      body: (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Fact label="کل حساب‌ها" value={toPersianDigits(accounts.total)} />
            <Fact label="حساب‌های فعال" value={toPersianDigits(accounts.active)} />
            <Fact
              label="بایگانی‌شده"
              value={toPersianDigits(accounts.archived)}
              hint="حساب بایگانی‌شده برای سند جدید پیشنهاد نمی‌شود، اما سوابقش در گزارش‌ها می‌ماند."
            />
          </div>
          <AppSettingsShortcut
            href={accountingSectionHref("chart-of-accounts")}
            label="باز کردن سرفصل حساب‌ها"
            description="سرفصل‌ها صفحهٔ کامل خودشان را دارند؛ ویرایش آن‌ها همان‌جا انجام می‌شود."
          />
        </div>
      ),
    },
    {
      key: "fiscal-periods",
      label: "سال و دوره‌های مالی",
      description: "تعریف سال مالی، بستن موقت و قفل کردن دوره‌ها.",
      icon: CalendarRangeIcon,
      body: (
        <div className="space-y-4">
          {fiscal.yearCount === 0 ? (
            /*
             * The one piece of configuration whose absence actively blocks
             * work: with no fiscal year there are no periods to close, and the
             * period lock that protects a closed month cannot apply. Said as a
             * warning rather than as a zero in a row of counts.
             */
            <p className="rounded-xl border border-dashed border-amber-300/70 bg-amber-50/60 px-3 py-4 text-sm leading-6 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              هنوز هیچ سال مالی تعریف نشده است. تا وقتی سال مالی تعریف نشود، امکان بستن یا قفل کردن دوره‌ها وجود ندارد.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Fact
                label="سال مالی جاری"
                value={fiscal.currentYearLabel ? toPersianDigits(fiscal.currentYearLabel) : "تعریف نشده"}
                tone={fiscal.currentYearLabel ? undefined : "danger"}
                hint={
                  fiscal.currentYearLabel
                    ? undefined
                    : `${toPersianDigits(fiscal.yearCount)} سال مالی تعریف شده، اما هیچ‌کدام شامل امروز نیست.`
                }
              />
              <Fact label="دوره‌های باز" value={toPersianDigits(fiscal.openPeriods)} />
              <Fact label="بستهٔ موقت" value={toPersianDigits(fiscal.softClosedPeriods)} />
              <Fact label="قفل‌شده" value={toPersianDigits(fiscal.lockedPeriods)} />
            </div>
          )}
          {fiscal.yearCount > 0 && periodTotal === 0 && fiscal.currentYearLabel ? (
            <p className="text-xs leading-5 text-muted-foreground">
              برای سال مالی جاری هنوز دوره‌ای ثبت نشده است.
            </p>
          ) : null}
          <AppSettingsShortcut
            href={accountingSectionHref("fiscal-periods")}
            label="باز کردن دوره‌های مالی"
            description="وضعیت هر دوره (باز، بستهٔ موقت، قفل) در همان صفحه مدیریت می‌شود."
          />
        </div>
      ),
    },
    {
      key: "vat",
      label: "قواعد مالیاتی دفتر",
      description: "نرخ مالیات بر ارزش افزوده و حساب‌های مالیاتی این دفتر.",
      icon: PercentIcon,
      body: (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Fact
              label="نرخ پیش‌فرض مالیات بر ارزش افزوده"
              value={settings.vatRate === null ? "تعریف نشده" : `${toPersianDigits(settings.vatRate)}٪`}
              tone={settings.vatRate === null ? "danger" : undefined}
              hint={
                settings.vatRate === null
                  ? "نرخ مالیات هنوز در تنظیمات کسب‌وکار ثبت نشده است."
                  : "این نرخ در تنظیمات پلتفرم تعریف می‌شود و همین دفتر از آن استفاده می‌کند."
              }
            />
            <Fact
              label="صنف کسب‌وکار"
              value={settings.industryLabel}
              hint="سرفصل‌ها و قواعد سندزنی بر پایهٔ همین صنف تعیین می‌شوند."
            />
          </div>
          <AppSettingsShortcut
            href={accountingSectionHref("vat")}
            label="باز کردن گزارش مالیات"
            description="مالیات ستاندهٔ فروش و مالیات پرداختی خرید، در گزارش مالیات بر ارزش افزوده."
          />
        </div>
      ),
    },
    {
      key: "posting",
      label: "قواعد سندزنی خودکار",
      description: "اینکه فروش، خرید، هزینه و حقوق با چه حساب‌هایی سند بخورند.",
      icon: WorkflowIcon,
      body: (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Fact
              label="سیستم انبار"
              value={INVENTORY_SYSTEM_LABELS[settings.inventorySystem] ?? settings.inventorySystem}
              hint={
                settings.inventorySystem === "periodic"
                  ? "در سیستم ادواری، بهای تمام‌شده هنگام بستن دوره شناسایی می‌شود."
                  : "در سیستم دائمی، بهای تمام‌شده هم‌زمان با هر فروش ثبت می‌شود."
              }
            />
            <Fact
              label="روش قیمت‌گذاری موجودی"
              value={
                settings.costingMethod
                  ? COSTING_LABELS[settings.costingMethod] ?? settings.costingMethod
                  : "تعریف نشده"
              }
              tone={settings.costingMethod ? undefined : "danger"}
            />
          </div>
          <div className="space-y-3">
            {settings.postingRules.map((rule) => (
              <PostingRuleCard key={rule.key} rule={rule} />
            ))}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            این قواعد ساختاری‌اند و ثبت خودکار، حساب‌ها را با «کد» پیدا می‌کند؛ به همین دلیل این حساب‌ها
            محافظت‌شده‌اند و قابل حذف یا غیرفعال کردن نیستند. نام هر حساب را می‌توانید در سرفصل حساب‌ها ویرایش کنید.
          </p>
        </div>
      ),
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
