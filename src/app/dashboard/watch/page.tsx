import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
import { WatchManager } from "./watch-manager";

export default async function WatchPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  await requireIndustryForPage(session.businessId, "watch");

  return (
    <PageShell>
      <PageHeader
        title="ساعت"
        description="مدل‌ها و دستگاه‌های سریال‌دار، فروش با گارانتی، و تیکت‌های تعمیر."
        actions={<KnowledgeHelpButton section="watch" />}
      />
      <WatchManager />
    </PageShell>
  );
}
