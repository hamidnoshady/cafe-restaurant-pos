import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { getBackupHealth } from "@/lib/backup-service";
import { isSetupComplete } from "@/lib/setup-state";
import { effectiveFeatures } from "@/lib/features";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { DashboardOverview } from "./overview/dashboard-overview";
import { AiChatHub } from "./ai/ai-chat-hub";

/**
 * `/dashboard` is the workspace home (Phase 35 Wave 2).
 *
 * When the `workspace` feature flag is on, this is the chat home — the same
 * full-page assistant hub used by `/dashboard/ai`, composed from the shared
 * `useAiChat` core. When it is off, the page is exactly the legacy dashboard,
 * unchanged, now also reachable at `/dashboard/overview`. One branch, not two
 * component trees: the flag is read here and in the layout, and everything else
 * is shared. Note the assistant hub reads `?conversation=` / `?ctx=` from the
 * URL itself, so "open a recent thread" and "ask about this page" links just
 * navigate here with those params.
 */
export default async function DashboardPage() {
  const today = toPersianDigits(formatJalali(new Date(), { withMonthName: true }));
  const session = await getSession();
  const canSetup = session?.role === "owner" || session?.role === "manager";
  const [setupDone, features, backupHealth, industryRead] = session
    ? await withTenant(
        session.businessId,
        () =>
          Promise.all([
            isSetupComplete(session.businessId),
            effectiveFeatures(session.businessId),
            canSetup ? getBackupHealth(session.businessId).catch(() => null) : Promise.resolve(null),
            getBusinessIndustry(session.businessId),
          ]),
        { locationId: session.locationId, userId: session.sub },
      )
    : [true, null, null, null];
  const industry = industryRead ?? "food_service";
  const workspaceEnabled = Boolean(features?.workspace);

  if (workspaceEnabled) {
    return (
      <AiChatHub />
    );
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
