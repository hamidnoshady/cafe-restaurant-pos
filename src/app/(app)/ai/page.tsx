import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { featureLockedForPage } from "@/lib/features";
import { FeatureLock } from "@/components/feature-lock";
import { AiWorkspace } from "@/app/dashboard/ai/ai-workspace";

export default async function AiPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  // `ai_assistant` is lockable: a business without it sees the workspace rather
  // than being bounced back to /dashboard, but cannot use any of it.
  const locked = await featureLockedForPage(session.businessId, "ai_assistant");

  return (
    <FeatureLock locked={locked} title="دستیار هوشمند">
      <AiWorkspace />
    </FeatureLock>
  );
}
