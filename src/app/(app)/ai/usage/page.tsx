import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { featureLockedForPage } from "@/lib/features";
import { AiWorkspacePage } from "../ai-workspace-page";
import { UsageDashboard } from "./usage-dashboard";

/**
 * «مصرف و هزینه» — the AI Workspace's usage section (Phase I).
 *
 * A read-only view of what AI has cost the business, over the same wallet
 * settlements every turn already writes. Behind the same `ai_assistant` lock
 * and owner/manager gate the rest of the workspace uses; the numbers are the
 * caller's own business only (RLS + the route's tenant scope).
 */
export default async function AiUsagePage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  const locked = await featureLockedForPage(session.businessId, "ai_assistant");

  return (
    <AiWorkspacePage
      locked={locked}
      title="مصرف و هزینه"
      description="هزینهٔ هوش مصنوعی کسب‌وکار شما بر پایهٔ کیف پول: چقدر خرج شده، صرف چه کاری شده، با چه مدلی، و چقدر از حافظهٔ پاسخ استفاده شده است."
    >
      <UsageDashboard />
    </AiWorkspacePage>
  );
}
