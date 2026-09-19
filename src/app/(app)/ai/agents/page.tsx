import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { featureLockedForPage } from "@/lib/features";
import { AiWorkspacePage } from "../ai-workspace-page";
import { AgentsManager } from "./agents-manager";

/**
 * «ایجنت‌ها» — the AI Workspace's custom-agent section (Phase I).
 *
 * The engine shipped in Phase D (custom agents with their own instructions,
 * read-tool allowlist and action allowlist; the chat route already runs a turn
 * under one via `agentId`), but its management UI was deferred here. This page
 * mounts the manager behind the same `ai_assistant` lock and owner/manager gate
 * the rest of the workspace uses.
 */
export default async function AiAgentsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  const locked = await featureLockedForPage(session.businessId, "ai_assistant");

  return (
    <AiWorkspacePage
      locked={locked}
      title="ایجنت‌ها"
      description="دستیارهای سفارشی کسب‌وکار: هر ایجنت نقش، ابزارهای خواندنی و اجازهٔ عملیات خودش را دارد و می‌توانید در گفت‌وگو آن را انتخاب کنید."
    >
      <AgentsManager />
    </AiWorkspacePage>
  );
}
