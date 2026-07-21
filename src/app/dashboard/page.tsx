import Link from "next/link";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { getSession } from "@/lib/auth";
import { getBackupHealth } from "@/lib/backup-service";
import { isSetupComplete } from "@/lib/setup-state";
import { DashboardGrid } from "./dashboard-grid";

const BACKUP_ALERT_LABELS: Record<string, string> = {
  local_failed: "آخرین پشتیبان‌گیری محلی ناموفق بود.",
  local_stale: "مدت زیادی از آخرین پشتیبان محلی موفق گذشته است.",
  cloud_failed: "آخرین بارگذاری پشتیبان ابری ناموفق بود.",
  cloud_stale: "مدت زیادی از آخرین پشتیبان ابری موفق گذشته است.",
};

export default async function DashboardPage() {
  const today = toPersianDigits(formatJalali(new Date(), { withMonthName: true }));
  const session = await getSession();
  const canSetup = session?.role === "owner" || session?.role === "manager";
  const setupDone = session ? await isSetupComplete(session.businessId) : true;
  // Phase 10 exit criterion: a failed/missed backup surfaces right on the
  // Owner's dashboard, not only on the backup page nobody may be watching.
  const backupHealth =
    session && canSetup ? await getBackupHealth(session.businessId).catch(() => null) : null;

  return (
    <div>
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">داشبورد</h1>
        <p className="text-sm text-muted-foreground">امروز: {today}</p>
      </header>

      {canSetup && !setupDone ? (
        <Link
          href="/setup"
          className="mb-6 flex items-center justify-between rounded-xl border border-primary/30 bg-primary/5 px-5 py-4 text-sm text-primary transition hover:bg-primary/10"
        >
          <span>
            <b>راه‌اندازی اولیه کامل نشده است.</b> برای آماده‌شدن جهت ثبت سفارش، جادوگر راه‌اندازی را
            تکمیل کنید.
          </span>
          <span className="font-semibold">ادامهٔ راه‌اندازی ←</span>
        </Link>
      ) : null}

      {backupHealth?.alert.level === "error" ? (
        <Link
          href="/dashboard/backup"
          className="mb-6 flex items-center justify-between rounded-xl border border-destructive/40 bg-destructive/10 px-5 py-4 text-sm text-destructive transition hover:bg-destructive/15"
        >
          <span>
            <b>هشدار پشتیبان‌گیری:</b>{" "}
            {BACKUP_ALERT_LABELS[backupHealth.alert.reason] ?? "وضعیت پشتیبان‌گیری را بررسی کنید."}
          </span>
          <span className="font-semibold">بررسی ←</span>
        </Link>
      ) : null}
      {session?.role === "owner" && backupHealth?.alert.reason === "disabled" && setupDone ? (
        <Link
          href="/dashboard/backup"
          className="mb-6 flex items-center justify-between rounded-xl border border-amber-500/40 bg-amber-500/10 px-5 py-4 text-sm text-amber-700 transition hover:bg-amber-500/15 dark:text-amber-400"
        >
          <span>
            <b>پشتیبان‌گیری خودکار هنوز فعال نیست.</b> برای محافظت از داده‌ها، زمان‌بندی پشتیبان‌گیری
            را فعال کنید.
          </span>
          <span className="font-semibold">فعال‌سازی ←</span>
        </Link>
      ) : null}

      <DashboardGrid canEdit={canSetup} />
    </div>
  );
}
