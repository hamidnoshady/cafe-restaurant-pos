import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { featureLockedForPage } from "@/lib/features";
import { FeatureLock } from "@/components/feature-lock";
import { AiChatHub } from "./ai-chat-hub";

export default async function AiSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  // `ai_assistant` is lockable: a business without it sees the hub rather than
  // being bounced back to /dashboard, but cannot use any of it.
  const locked = await featureLockedForPage(session.businessId, "ai_assistant");

  return (
    <FeatureLock locked={locked} title="دستیار هوشمند">
      <AiChatHub />
    </FeatureLock>
  );
}
