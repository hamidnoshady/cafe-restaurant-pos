import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { featureLockedForPage } from "@/lib/features";
import { FeatureLock } from "@/components/feature-lock";
import { PageHeader, PageShell } from "../../page-chrome";
import { AiAutopilotSettings } from "../ai-autopilot-settings";
import { AiProactiveSettings } from "../ai-proactive-settings";
import { AiBillingDashboard } from "../ai-billing";

/**
 * The assistant's settings, opened from the sidebar footer («تنظیمات هوش
 * مصنوعی»): what the assistant may run on its own, the background digests,
 * and the credit it spends. Each section is the same component the console
 * already ships; this page just gives the owner one place for all of it.
 */
export default async function AiSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  // `ai_assistant` is lockable: a business without it sees the settings as a
  // read-only preview rather than being bounced back to /dashboard.
  const locked = await featureLockedForPage(session.businessId, "ai_assistant");

  return (
    <PageShell>
      <PageHeader
        title="تنظیمات هوش مصنوعی"
        description="اجرای خودکار، گزارش‌های پس‌زمینه و اعتبار دستیار — در یک جا."
      />
      <FeatureLock locked={locked} title="دستیار هوشمند">
        <div className="space-y-6">
          <AiAutopilotSettings />
          <AiProactiveSettings />
          <AiBillingDashboard />
        </div>
      </FeatureLock>
    </PageShell>
  );
}
