import Link from "next/link";
import { toPersianDigits } from "@/lib/digits";
import type { Role } from "@/lib/auth";
import type { Industry } from "@/lib/industries";
import type { BackupHealth } from "@/lib/backup-service";
import { industryProfile } from "@/lib/industry-profile";
import { OperationsOverview } from "../operations-overview";
import { RetailOverview } from "../retail-overview";
import { PinnedReports } from "../pinned-reports";
import { SetupBanner } from "../setup-banner";
import { PageHeader, PageShell } from "../page-chrome";

const BACKUP_ALERT_LABELS: Record<string, string> = {
  local_failed: "آخرین پشتیبان‌گیری محلی ناموفق بود.",
  local_stale: "مدت زیادی از آخرین پشتیبان محلی موفق گذشته است.",
  cloud_failed: "آخرین بارگذاری پشتیبان ابری ناموفق بود.",
  cloud_stale: "مدت زیادی از آخرین پشتیبان ابری موفق گذشته است.",
};

const OPERATIONAL_ROLES = ["owner", "manager", "cashier", "waiter"] as const;

interface DashboardOverviewProps {
  today: string;
  role: Role | null;
  canSetup: boolean;
  setupDone: boolean;
  features: Record<string, boolean> | null;
  backupHealth: BackupHealth | null;
  industry: Industry;
}

/**
 * The legacy dashboard, factored out of `/dashboard/page.tsx` so it can be shown
 * both at `/dashboard/overview` (always) and at `/dashboard` when the workspace
 * shell is off (Phase 35 Wave 2). Behavior is unchanged — same widgets, same
 * numbers — only its location moved.
 */
export function DashboardOverview({
  today,
  role,
  canSetup,
  setupDone,
  features,
  backupHealth,
  industry,
}: DashboardOverviewProps) {
  const isRetail = industryProfile(industry).salesModel === "retail_invoice";
  const hasOperationalOverview = role ? OPERATIONAL_ROLES.includes(role as (typeof OPERATIONAL_ROLES)[number]) : false;

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
            {BACKUP_ALERT_LABELS[backupHealth.alert.reason] ?? "وضعیت پشتیبان‌گیری را بررسی کنید."}
          </span>
          <span className="shrink-0 font-semibold">بررسی ←</span>
        </Link>
      ) : null}
      {role === "owner" && backupHealth?.alert.reason === "disabled" && setupDone ? (
        <Link
          href="/dashboard/backup"
          className="mb-4 flex flex-col items-start gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/[0.075] px-4 py-3.5 text-sm text-amber-800 shadow-[0_2px_7px_rgb(41_37_36/0.04)] transition-colors hover:bg-amber-500/[0.12] sm:flex-row sm:items-center sm:justify-between sm:px-5"
        >
          <span>
            <b>پشتیبان‌گیری خودکار هنوز فعال نیست.</b> برای محافظت از داده‌ها،
            زمان‌بندی پشتیبان‌گیری را فعال کنید.
          </span>
          <span className="shrink-0 font-semibold">فعال‌سازی ←</span>
        </Link>
      ) : null}

      {role && isRetail ? <RetailOverview industry={industry} /> : null}

      {hasOperationalOverview && role && !isRetail ? (
        <OperationsOverview role={role as (typeof OPERATIONAL_ROLES)[number]} />
      ) : null}

      <PinnedReports
        canEdit={canSetup}
        canExplain={canSetup && Boolean(features?.ai_assistant)}
      />
    </PageShell>
  );
}
