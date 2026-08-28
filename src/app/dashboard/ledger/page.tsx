import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { effectiveFeatures, requireFeatureForPage } from "@/lib/features";
import { withTenant } from "@/lib/db";
import { hasActiveHolooCompanion } from "@/lib/integrations/holoo/connection-service";
import { PageHeader, PageShell } from "../page-chrome";
import { LedgerManager } from "./ledger-manager";
import { AskAssistant } from "@/components/ai/ask-assistant";

export default async function LedgerPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "accountant"].includes(session.role)) redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "ledger");
  const holooCompanion = await withTenant(session.businessId, () => hasActiveHolooCompanion(session.businessId));
  const features = await effectiveFeatures(session.businessId);

  return (
    <PageShell>
      {holooCompanion ? (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
          دفتر رسمی در هلو نگهداری می‌شود؛ این دفتر برای گزارش، پایش و تطبیق آینه می‌شود.
        </div>
      ) : null}
      <PageHeader
        title="حسابداری"
        description="تراز آزمایشی، دفتر روزنامه، اسناد دستی و عملیات مالی کسب‌وکار."
        actions={
          features.ai_assistant ? (
            <AskAssistant
              app="growth"
              context="وضعیت حسابداری را بررسی کن: تراز آزمایشی، دفتر روزنامه و اسناد ثبت‌شده."
            />
          ) : null
        }
      />
      <LedgerManager role={session.role} />
    </PageShell>
  );
}
