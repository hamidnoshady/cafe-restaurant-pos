import Link from "next/link";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { getSession } from "@/lib/auth";
import { getBackupHealth } from "@/lib/backup-service";
import { isSetupComplete } from "@/lib/setup-state";
import { OperationsOverview } from "./operations-overview";
import { PinnedReports } from "./pinned-reports";

const BACKUP_ALERT_LABELS: Record<string, string> = {
  local_failed: "آخرین پشتیبان‌گیری محلی ناموفق بود.",
  local_stale: "مدت زیادی از آخرین پشتیبان محلی موفق گذشته است.",
  cloud_failed: "آخرین بارگذاری پشتیبان ابری ناموفق بود.",
  cloud_stale: "مدت زیادی از آخرین پشتیبان ابری موفق گذشته است.",
};

const OPERATIONAL_ROLES = ["owner", "manager", "cashier", "waiter"] as const;

export default async function DashboardPage() {
  const today = toPersianDigits(formatJalali(new Date(), { withMonthName: true }));
  const session = await getSession();
  const canSetup = session?.role === "owner" || session?.role === "manager";
  const setupDone = session ? await isSetupComplete(session.businessId) : true;
  // Phase 10 exit criterion: a failed/missed backup surfaces right on the
  // Owner's dashboard, not only on the backup page nobody may be watching.
  const backupHealth =
    session && canSetup ? await getBackupHealth(session.businessId).catch(() => null) : null;
  const hasOperationalOverview = session ? OPERATIONAL_ROLES.includes(session.role as (typeof OPERATIONAL_ROLES)[number]) : false;

  return (
    <div className="mx-auto w-full max-w-[1440px] pb-6">
      {!hasOperationalOverview ? (
        <header className="mb-5 flex items-baseline justify-between border-b border-border/80 pb-4">
          <h1 className="text-2xl font-bold">داشبورد</h1>
          <p className="text-sm text-muted-foreground">امروز: {today}</p>
        </header>
      ) : null}

      {canSetup && !setupDone ? (
        <Link
          href="/setup"
          className="mb-4 flex flex-col items-start gap-3 rounded-2xl border border-primary/25 bg-primary/[0.045] px-4 py-3.5 text-sm text-primary shadow-[0_2px_7px_rgb(15_23_42/0.04)] transition-colors hover:bg-primary/[0.075] sm:flex-row sm:items-center sm:justify-between sm:px-5"
        >
          <span>
            <b>راه‌اندازی اولیه کامل نشده است.</b> برای آماده‌شدن جهت ثبت سفارش، جادوگر راه‌اندازی را
            تکمیل کنید.
          </span>
          <span className="shrink-0 font-semibold">ادامهٔ راه‌اندازی ←</span>
        </Link>
      ) : null}

      {backupHealth?.alert.level === "error" ? (
        <Link
          href="/dashboard/backup"
          className="mb-4 flex flex-col items-start gap-3 rounded-2xl border border-destructive/25 bg-destructive/[0.055] px-4 py-3.5 text-sm text-destructive shadow-[0_2px_7px_rgb(15_23_42/0.04)] transition-colors hover:bg-destructive/[0.09] sm:flex-row sm:items-center sm:justify-between sm:px-5"
        >
          <span>
            <b>هشدار پشتیبان‌گیری:</b>{" "}
            {BACKUP_ALERT_LABELS[backupHealth.alert.reason] ?? "وضعیت پشتیبان‌گیری را بررسی کنید."}
          </span>
          <span className="shrink-0 font-semibold">بررسی ←</span>
        </Link>
      ) : null}
      {session?.role === "owner" && backupHealth?.alert.reason === "disabled" && setupDone ? (
        <Link
          href="/dashboard/backup"
          className="mb-4 flex flex-col items-start gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/[0.075] px-4 py-3.5 text-sm text-amber-800 shadow-[0_2px_7px_rgb(15_23_42/0.04)] transition-colors hover:bg-amber-500/[0.12] dark:text-amber-300 sm:flex-row sm:items-center sm:justify-between sm:px-5"
        >
          <span>
            <b>پشتیبان‌گیری خودکار هنوز فعال نیست.</b> برای محافظت از داده‌ها، زمان‌بندی پشتیبان‌گیری
            را فعال کنید.
          </span>
          <span className="shrink-0 font-semibold">فعال‌سازی ←</span>
        </Link>
      ) : null}

      {hasOperationalOverview && session ? <OperationsOverview role={session.role as (typeof OPERATIONAL_ROLES)[number]} /> : null}

      <PinnedReports canEdit={canSetup} />
    </div>
  );
}
