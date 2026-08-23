import Link from "next/link";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { getSession } from "@/lib/auth";
import { getBackupHealth } from "@/lib/backup-service";
import { isSetupComplete } from "@/lib/setup-state";
import { effectiveFeatures } from "@/lib/features";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { industryProfile } from "@/lib/industry-profile";
import { OperationsOverview } from "./operations-overview";
import { RetailOverview } from "./retail-overview";
import { PinnedReports } from "./pinned-reports";
import { SetupBanner } from "./setup-banner";
import { PageHeader, PageShell } from "./page-chrome";

const BACKUP_ALERT_LABELS: Record<string, string> = {
  local_failed: "آخرین پشتیبان‌گیری محلی ناموفق بود.",
  local_stale: "مدت زیادی از آخرین پشتیبان محلی موفق گذشته است.",
  cloud_failed: "آخرین بارگذاری پشتیبان ابری ناموفق بود.",
  cloud_stale: "مدت زیادی از آخرین پشتیبان ابری موفق گذشته است.",
};

const OPERATIONAL_ROLES = ["owner", "manager", "cashier", "waiter"] as const;

export default async function DashboardPage() {
  const today = toPersianDigits(
    formatJalali(new Date(), { withMonthName: true }),
  );
  const session = await getSession();
  const canSetup = session?.role === "owner" || session?.role === "manager";
  const [setupDone, features] = session
    ? await Promise.all([
        isSetupComplete(session.businessId),
        effectiveFeatures(session.businessId),
      ])
    : [true, null];
  // Phase 10 exit criterion: a failed/missed backup surfaces right on the
  // Owner's dashboard, not only on the backup page nobody may be watching.
  const backupHealth =
    session && canSetup
      ? await getBackupHealth(session.businessId).catch(() => null)
      : null;
  const industry = session ? ((await getBusinessIndustry(session.businessId)) ?? "food_service") : "food_service";
  // A shop has no open order tickets, no tables and no kitchen, so the F&B
  // overview would render a permanently empty «سفارش‌های فعال» table for it.
  const isRetail = industryProfile(industry).salesModel === "retail_invoice";
  const hasOperationalOverview = session
    ? OPERATIONAL_ROLES.includes(
        session.role as (typeof OPERATIONAL_ROLES)[number],
      )
    : false;

  return (
    <PageShell className="pb-6">
      {!hasOperationalOverview && !isRetail ? (
        <PageHeader
          title="داشبورد"
          actions={<p className="text-sm text-muted-foreground">امروز: {today}</p>}
        />
      ) : null}

      {canSetup && !setupDone ? <SetupBanner /> : null}

      {backupHealth?.alert.level === "error" ? (
        <Link
          href="/dashboard/backup"
          className="mb-4 flex flex-col items-start gap-3 rounded-2xl border border-destructive/25 bg-destructive/[0.055] px-4 py-3.5 text-sm text-destructive shadow-[0_2px_7px_rgb(41_37_36/0.04)] transition-colors hover:bg-destructive/[0.09] sm:flex-row sm:items-center sm:justify-between sm:px-5"
        >
          <span>
            <b>هشدار پشتیبان‌گیری:</b>{" "}
            {BACKUP_ALERT_LABELS[backupHealth.alert.reason] ??
              "وضعیت پشتیبان‌گیری را بررسی کنید."}
          </span>
          <span className="shrink-0 font-semibold">بررسی ←</span>
        </Link>
      ) : null}
      {session?.role === "owner" &&
      backupHealth?.alert.reason === "disabled" &&
      setupDone ? (
        <Link
          href="/dashboard/backup"
          className="mb-4 flex flex-col items-start gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/[0.075] px-4 py-3.5 text-sm text-amber-800 shadow-[0_2px_7px_rgb(41_37_36/0.04)] transition-colors hover:bg-amber-500/[0.12] dark:text-amber-300 sm:flex-row sm:items-center sm:justify-between sm:px-5"
        >
          <span>
            <b>پشتیبان‌گیری خودکار هنوز فعال نیست.</b> برای محافظت از داده‌ها،
            زمان‌بندی پشتیبان‌گیری را فعال کنید.
          </span>
          <span className="shrink-0 font-semibold">فعال‌سازی ←</span>
        </Link>
      ) : null}

      {session && isRetail ? <RetailOverview industry={industry} /> : null}

      {hasOperationalOverview && session && !isRetail ? (
        <OperationsOverview
          role={session.role as (typeof OPERATIONAL_ROLES)[number]}
        />
      ) : null}

      <PinnedReports
        canEdit={canSetup}
        canExplain={canSetup && Boolean(features?.ai_assistant)}
      />
    </PageShell>
  );
}
