import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { featureLockedForPage } from "@/lib/features";
import { AiWorkspacePage } from "../ai-workspace-page";
import { AutomationsManager } from "./automations-manager";

/**
 * «اتوماسیون‌ها» — the AI Workspace's automation section (Phase I).
 *
 * The engine (Phase D) validated, gathered facts and fired through the shared
 * guarded path, but had no UI — it was deferred here. This page mounts the
 * manager behind the same `ai_assistant` lock and owner/manager gate the rest
 * of the workspace uses. Only an owner may set a rule to apply unattended, so
 * that option is shown only to an owner (`canAutoApply`), mirroring the
 * server-side `owner_required` check the route enforces anyway.
 */
export default async function AiAutomationsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  const locked = await featureLockedForPage(session.businessId, "ai_assistant");

  return (
    <AiWorkspacePage
      locked={locked}
      title="اتوماسیون‌ها"
      description="قاعده‌های «هر وقت… اگر… آنگاه…» کسب‌وکار: در زمان یا رویدادی مشخص، وقتی شرطی برقرار شد، کاری پیشنهاد یا — در سقف‌های شما — ثبت شود."
    >
      <AutomationsManager canAutoApply={session.role === "owner"} />
    </AiWorkspacePage>
  );
}
