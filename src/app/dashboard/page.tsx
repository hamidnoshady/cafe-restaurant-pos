import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { featureLockedForPage } from "@/lib/features";
import { canManageAi } from "@/lib/ai-panel";
import { FeatureLock } from "@/components/feature-lock";
import { AiChatHub } from "./ai/ai-chat-hub";

/**
 * `/dashboard` — the tenant's home, and the assistant's one canonical address.
 *
 * There is exactly one dashboard: the AI chat hub, composed from the shared
 * `useAiChat` core, with the composer's task/agent selection, attachments and
 * propose→confirm actions. The old quick-report dashboard (and the
 * `workspace` rollout flag that chose between the two) are retired — every
 * tenant lands here, and the retired addresses (`/overview`, `/dashboard/overview`,
 * `/ai`, `/dashboard/ai/<section>`) resolve here too, query parameters kept
 * (the hub reads `?conversation=` / `?ctx=` / `?project=` and the
 * `?aiPanel=<section>` management panel from the URL itself).
 *
 * The `ai_assistant` entitlement is preserved, not bypassed: a business
 * without it still sees the same home, as the read-only `FeatureLock` preview
 * (the API guard in `withTenantScope` keeps refusing `/api/ai/*` regardless).
 *
 * Management of the assistant (agents, coworkers, automations, activity,
 * knowledge, usage) opens from the chat itself as the `?aiPanel=` drawer —
 * owner/manager only, the same gate the retired `/ai` application applied;
 * auto-apply authority stays owner-only.
 */
export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const locked = await featureLockedForPage(session.businessId, "ai_assistant");

  return (
    <FeatureLock locked={locked} title="دستیار هوشمند">
      <AiChatHub
        canManageAi={canManageAi(session.role)}
        canAutoApply={session.role === "owner"}
      />
    </FeatureLock>
  );
}
