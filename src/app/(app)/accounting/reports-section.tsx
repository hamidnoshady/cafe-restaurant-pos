"use client";

/**
 * Accounting → «گزارش‌های مالی».
 *
 * The financial statements themselves are built by the business's reports
 * workspace (`/dashboard/reports`), which is a *platform* surface shared with
 * the sales and operations reporting. What was missing was an entrance to them
 * from inside Accounting: an accountant looking for a trial balance had to
 * leave the app, find «گزارش‌ها» in the business nav and know which tab held
 * the ledger reports.
 *
 * So this section is an index, not a second report engine. Every link says
 * plainly where it goes, and the two that leave the app say so in words — the
 * rule the settings separation follows everywhere: a surface that belongs to
 * another area is *labelled* as belonging to it rather than silently rendered
 * here.
 */

import Link from "next/link";
import {
  ArrowUpRightIcon,
  BarChart3Icon,
  CalculatorIcon,
  ClipboardListIcon,
  PercentIcon,
  ScrollTextIcon,
  type LucideIcon,
} from "lucide-react";
import { SectionCard, cardClass } from "@/app/dashboard/page-chrome";
import { accountingSectionHref } from "./accounting-routes";

interface ReportLink {
  label: string;
  description: string;
  href: string;
  icon: LucideIcon;
  /** True when the link leaves the Accounting app — said out loud on the card. */
  external?: boolean;
}

const IN_APP_REPORTS: ReportLink[] = [
  {
    label: "تراز آزمایشی",
    description: "مانده بدهکار و بستانکار همهٔ حساب‌ها در یک نگاه.",
    href: accountingSectionHref("trial-balance"),
    icon: CalculatorIcon,
  },
  {
    label: "دفتر روزنامه",
    description: "همهٔ اسناد ثبت‌شده، با امکان جست‌وجو و فیلتر.",
    href: accountingSectionHref("entries"),
    icon: ClipboardListIcon,
  },
  {
    label: "گزارش مالیات بر ارزش افزوده",
    description: "مالیات فروش و خرید دوره، آمادهٔ اظهارنامه.",
    href: accountingSectionHref("vat"),
    icon: PercentIcon,
  },
  {
    label: "دریافت و پرداخت",
    description: "گردش وجه نقد و بانک در بازهٔ انتخابی.",
    href: accountingSectionHref("receipts"),
    icon: ScrollTextIcon,
  },
];

const PLATFORM_REPORTS: ReportLink[] = [
  {
    label: "گزارش‌های کسب‌وکار (پلتفرم)",
    description:
      "صورت سود و زیان، ترازنامه و گزارش‌ساز در بخش گزارش‌های کسب‌وکار قرار دارد — بیرون از برنامهٔ حسابداری.",
    href: "/dashboard/reports",
    icon: BarChart3Icon,
    external: true,
  },
];

function ReportCard({ link }: { link: ReportLink }) {
  const Icon = link.icon;
  return (
    <Link
      href={link.href}
      className={`${cardClass} flex gap-3 p-4 transition-colors hover:border-amber-300/70 hover:bg-amber-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:hover:border-amber-500/40 dark:hover:bg-amber-500/10 dark:focus-visible:ring-amber-400/45`}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-300" />
      <span className="min-w-0">
        <span className="flex items-center gap-1 font-semibold text-foreground">
          {link.label}
          {link.external ? (
            <ArrowUpRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground rtl:rotate-90" />
          ) : null}
        </span>
        <span className="mt-1 block text-sm leading-6 text-muted-foreground">{link.description}</span>
      </span>
    </Link>
  );
}

export function AccountingReportsSection() {
  return (
    <div className="space-y-4">
      <SectionCard
        title="گزارش‌های حسابداری"
        description="گزارش‌هایی که خودِ برنامهٔ حسابداری می‌سازد."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {IN_APP_REPORTS.map((link) => (
            <ReportCard key={link.href} link={link} />
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title="گزارش‌های پلتفرم"
        description="این گزارش‌ها بیرون از برنامهٔ حسابداری و در بخش گزارش‌های کسب‌وکار قرار دارند."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {PLATFORM_REPORTS.map((link) => (
            <ReportCard key={link.href} link={link} />
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
