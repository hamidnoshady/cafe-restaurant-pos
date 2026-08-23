import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { featureLockedForPage } from "@/lib/features";
import { FeatureLock } from "@/components/feature-lock";
import { PageHeader, PageShell } from "../page-chrome";
import { AiChatHub } from "./ai-chat-hub";

export default async function AiSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  // `ai_assistant` is lockable: a business without it sees the hub rather than
  // being bounced back to /dashboard, but cannot use any of it.
  const locked = await featureLockedForPage(session.businessId, "ai_assistant");

  return (
    <PageShell>
      <PageHeader
        title="هوش مصنوعی"
        description="گفتگو با دستیار، سپردن کارهای تکرارشونده به همکار هوشمند و تأیید آن‌ها، و مدیریت اعتبار/گزارش‌های خودکار/گزارش ممیزی."
      />
      <FeatureLock locked={locked} title="دستیار هوشمند">
        {/* Pre-approving an unattended write is the Owner's call alone — the
            same rule the autopilot money category follows. The POST route
            enforces it too; this only keeps the option out of the form. */}
        <AiChatHub canAutoApply={session.role === "owner"} />
      </FeatureLock>
    </PageShell>
  );
}
