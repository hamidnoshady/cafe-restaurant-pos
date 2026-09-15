import { redirect } from "next/navigation";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { getBackupHealth } from "@/lib/backup-service";
import { isSetupComplete } from "@/lib/setup-state";
import { effectiveFeatures } from "@/lib/features";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { ACCOUNTING_HOME, canOpenAccounting } from "@/app/(app)/accounting/accounting-routes";
import { DashboardOverview } from "@/app/dashboard/overview/dashboard-overview";

export default async function DashboardOverviewPage() {
  const today = toPersianDigits(formatJalali(new Date(), { withMonthName: true }));
  const session = await getSession();
  const canSetup = session?.role === "owner" || session?.role === "manager";
  // Every DB-backed read below is wrapped in withTenant(), never the ambient
  // scope getSession() set via enterWith(): that scope is lost the moment a
  // background tick (backup/rollup/server-sync, all withTenant()/withoutTenantScope()
  // .run() calls) fires mid-request, and RLS then silently returns empty rows.
  // An empty settings read here made getBackupConfig fall back to the default
  // (enabled: false), so a working backup showed the «پشتیبان‌گیری خودکار هنوز
  // فعال نیست» banner — see settings/page.tsx and dashboard/layout.tsx, which
  // already wrap their reads the same way for the same reason.
  const [setupDone, features, backupHealth, industryRead] = session
    ? await withTenant(
        session.businessId,
        () =>
          Promise.all([
            isSetupComplete(session.businessId),
            effectiveFeatures(session.businessId),
            // Phase 10 exit criterion: a failed/missed backup surfaces right on
            // the Owner's dashboard, not only on the backup page nobody may be
            // watching.
            canSetup ? getBackupHealth(session.businessId).catch(() => null) : Promise.resolve(null),
            getBusinessIndustry(session.businessId),
          ]),
        { locationId: session.locationId, userId: session.sub },
      )
    : [true, null, null, null];
  const industry = industryRead ?? "food_service";

  // The old accounting-flavoured dashboard is superseded by the Accounting
  // app's own home (`/accounting/overview`). A member the app admits — and
  // whose business is entitled to the ledger — is forwarded there, so the two
  // dashboards never compete; everyone else (cashier, waiter, kitchen, or a
  // business without the ledger) keeps the operational overview this page has
  // always shown. A redirect, never a 404: every old bookmark still lands
  // somewhere real.
  if (session && canOpenAccounting(session.role) && features?.ledger) {
    redirect(ACCOUNTING_HOME);
  }

  return (
    <DashboardOverview
      today={today}
      role={session?.role ?? null}
      canSetup={canSetup}
      setupDone={setupDone}
      features={features}
      backupHealth={backupHealth}
      industry={industry}
    />
  );
}
