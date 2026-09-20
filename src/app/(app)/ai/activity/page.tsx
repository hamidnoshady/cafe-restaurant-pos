import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { featureLockedForPage } from "@/lib/features";
import { AiWorkspacePage } from "../ai-workspace-page";
import { AiAutopilotActivity } from "@/app/dashboard/ai/ai-autopilot-activity";

/**
 * «فعالیت خودکار» — the AI Workspace's autopilot activity section (Phase I).
 *
 * The feed of what the assistant did unattended, what it held back for the
 * owner to confirm, and the one-click revert — shipped as `AiAutopilotActivity`
 * but, like the coworker panel, mounted by no route. This gives it a home
 * beside the engines whose output it records.
 */
export default async function AiActivityPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  const locked = await featureLockedForPage(session.businessId, "ai_assistant");

  return (
    <AiWorkspacePage
      locked={locked}
      title="فعالیت خودکار"
      description="آنچه دستیار به‌صورت خودکار انجام داده، آنچه برای تأیید شما نگه داشته، و امکان برگرداندن هر مورد."
    >
      <AiAutopilotActivity />
    </AiWorkspacePage>
  );
}
