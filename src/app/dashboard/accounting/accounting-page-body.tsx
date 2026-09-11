import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { effectiveFeatures, requireFeatureForPage } from "@/lib/features";
import { withTenant } from "@/lib/db";
import { hasActiveHolooCompanion } from "@/lib/integrations/holoo/connection-service";
import { PageHeader, PageShell } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
import { AskAssistant } from "@/components/ai/ask-assistant";
import { AccountingManager } from "./accounting-manager";
import { canViewAccountingSection } from "./accounting-nav";
import {
  accountingFallbackHref,
  canOpenAccounting,
  type AccountingSectionKey,
} from "./accounting-routes";

/**
 * What every Accounting page renders, with the gates every one of them draws.
 *
 * The app is one route per section now (`/dashboard/accounting/<section>`),
 * and the pages are thin — this body is the whole app chrome, so a section
 * page and the app's home cannot drift apart. The gates run in order and in
 * one place: signed in, admitted to the app, admitted to *this* section
 * (payroll is the shorter list), entitled to the ledger.
 */
export async function AccountingPageBody({ section }: { section: AccountingSectionKey }) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canOpenAccounting(session.role)) redirect("/dashboard");
  if (!canViewAccountingSection(session.role, section)) redirect(accountingFallbackHref());
  await requireFeatureForPage(session.businessId, "ledger");
  const holooCompanion = await withTenant(session.businessId, () => hasActiveHolooCompanion(session.businessId));
  const features = await effectiveFeatures(session.businessId);

  return (
    <PageShell>
      {holooCompanion ? (
        <div className="mb-4 rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-4 py-3 text-sm leading-6 text-amber-950 dark:text-amber-200">
          دفتر رسمی در هلو نگهداری می‌شود؛ این دفتر برای گزارش، پایش و تطبیق آینه می‌شود.
        </div>
      ) : null}
      <PageHeader
        title="حسابداری"
        description="تراز آزمایشی، دفتر روزنامه، اسناد دستی و عملیات مالی کسب‌وکار."
        actions={
          <>
            <KnowledgeHelpButton section="ledger" />
            {features.ai_assistant ? (
              <AskAssistant
                app="growth"
                context="وضعیت حسابداری را بررسی کن: تراز آزمایشی، دفتر روزنامه و اسناد ثبت‌شده."
              />
            ) : null}
          </>
        }
      />
      <AccountingManager role={session.role} section={section} />
    </PageShell>
  );
}
