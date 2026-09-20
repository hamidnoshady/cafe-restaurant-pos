import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { featureLockedForPage } from "@/lib/features";
import { AiWorkspacePage } from "../ai-workspace-page";
import { AiCoworkerPanel } from "@/app/dashboard/ai/ai-coworker-panel";

/**
 * «همکاران هوشمند» — the AI Workspace's coworker section (Phase I).
 *
 * The coworker inbox, the delegated jobs and the accounting review shipped in
 * Phase 32 inside `AiCoworkerPanel`, but no route mounted it — the engine was
 * reachable only through the public API. This page gives it its home in the
 * workspace, behind the same `ai_assistant` feature lock and the same
 * owner/manager gate the rest of the workspace uses. Only an owner may hand a
 * job the authority to act unattended, so `canAutoApply` is the owner check.
 */
export default async function AiCoworkersPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  const locked = await featureLockedForPage(session.businessId, "ai_assistant");

  return (
    <AiWorkspacePage
      locked={locked}
      title="همکاران هوشمند"
      description="کارهای تکرارشوندهٔ حسابداری را یک بار توضیح دهید و بسپارید؛ آنچه برای تأیید مانده در صندوق تصمیم‌ها می‌آید."
    >
      <AiCoworkerPanel canAutoApply={session.role === "owner"} />
    </AiWorkspacePage>
  );
}
