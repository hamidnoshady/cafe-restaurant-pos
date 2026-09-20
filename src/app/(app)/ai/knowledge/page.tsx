import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { featureLockedForPage } from "@/lib/features";
import { AiWorkspacePage } from "../ai-workspace-page";
import { KnowledgeManager } from "./knowledge-manager";

/**
 * «دانش دستیار» — the AI Workspace's knowledge/retrieval section (Phase I).
 *
 * A read-only view of what the assistant can recall from the business's own
 * stored text (menu/item descriptions, item/customer names, project notes),
 * plus a manual reindex. Behind the same `ai_assistant` lock and owner/manager
 * gate the rest of the workspace uses.
 */
export default async function AiKnowledgePage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  const locked = await featureLockedForPage(session.businessId, "ai_assistant");

  return (
    <AiWorkspacePage
      locked={locked}
      title="دانش دستیار"
      description="دستیار برای پاسخ‌های دقیق‌تر، متن‌های کم‌تغییر کسب‌وکار شما — توضیح اقلام منو و کالاها، نام مشتریان و یادداشت پروژه‌ها — را نمایه می‌کند. عددها هرگز نمایه نمی‌شوند و همیشه زنده از ابزارها خوانده می‌شوند."
    >
      <KnowledgeManager />
    </AiWorkspacePage>
  );
}
