import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { PageHeader, PageShell } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
import { AskAssistant } from "@/components/ai/ask-assistant";
import { WebsiteSection } from "./website-section";

/**
 * The Website Manager (issue #378) — «وب‌سایت», its own app.
 *
 * Originally a section of Growth & Marketing; pulled out to be a peer app
 * (src/lib/apps.ts) because it is an integration with an external system of
 * record (eshobe-cms), not a marketing engine over this app's own tables —
 * see docs/eshobe-cms-integration.md. Owner/manager only, the same line the
 * connections app draws for its own machine credentials.
 */
export default async function WebsitePage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager"].includes(session.role)) redirect("/dashboard");

  return (
    <PageShell>
      <PageHeader
        title="وب‌سایت"
        description="سایت اینترنتی و فروشگاه آنلاین این کسب‌وکار — محتوا و کاتالوگ از سایت‌ساز پلتفرم خوانده می‌شود."
        actions={
          <>
            <KnowledgeHelpButton section="website" />
            <AskAssistant
              app="website"
              context="وضعیت اتصال وب‌سایت را بررسی کن: آیا سایت متصل است، دامنه تأیید شده، و سفارش‌های فروشگاه اینترنتی."
            />
          </>
        }
      />
      <WebsiteSection />
    </PageShell>
  );
}
