import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireFeatureForPage } from "@/lib/features";
import { AiChatHub } from "./ai-chat-hub";

export default async function AiSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "ai_assistant");

  return <AiChatHub />;
}
