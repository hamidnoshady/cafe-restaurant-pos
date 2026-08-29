/**
 * The CRM app shell (Phase 36).
 *
 * Wraps every `/dashboard/crm` route with the app's own header. The side menu
 * is *not* here: `src/lib/app-shells.ts` hands the dashboard's sidebar slot to
 * `crm/crm-app-nav.tsx` for these routes, so the app's menu sits at the level
 * the business's own pages sit at rather than as a sub-menu drawn inside a
 * page. That split is the whole difference between an app and a folder, and it
 * is the same arrangement the Growth app uses.
 */

import { PageHeader, PageShell } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
import { AskAssistant } from "@/components/ai/ask-assistant";

export function CrmAppShell({ children }: { children: React.ReactNode }) {
  return (
    <PageShell className="space-y-4 sm:space-y-5">
      <PageHeader
        title="ارتباط با مشتری"
        description="پروندهٔ کامل مشتری، بخش‌بندی رفتاری، قیف فروش، کارها و پیگیری‌ها، تیکت‌های خدمات و سابقهٔ رضایت ارتباط."
        actions={
          <>
            {/* No `section`: this header serves every CRM sub-page, so the
                button resolves the current route itself. */}
            <KnowledgeHelpButton />
            <AskAssistant
              app="crm"
              context="وضعیت مشتریان را بررسی کن: مشتریان تازه، مشتریان در معرض ریزش، بخش‌های تعریف‌شده و تعداد قابل‌ارسال هرکدام، کارهای عقب‌افتاده و تیکت‌های باز."
            />
          </>
        }
      />
      <div className="min-w-0">{children}</div>
    </PageShell>
  );
}
