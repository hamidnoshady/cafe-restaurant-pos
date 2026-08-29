/**
 * The Growth app shell (Phase 36b, revised again).
 *
 * Wraps every Growth route with the app's own header. Its side menu used to be
 * drawn here too, beside the content, *inside* the dashboard's sidebar — which
 * still showed the business's flat nav, accounting included. That made the app
 * look like a page of accounting with a sub-menu of its own.
 *
 * The app now owns the sidebar itself: `src/lib/app-shells.ts` hands the slot to
 * `growth/growth-app-nav.tsx` for every route under `/dashboard/growth`, so this
 * shell is the header and the page, at the width the rest of the dashboard uses.
 * The bridge to accounting is deliberately not surfaced here either: the work
 * passes through the ledger in the backend, and the app shows only its own
 * numbers.
 */

import { PageHeader, PageShell } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
import { AskAssistant } from "@/components/ai/ask-assistant";

export function GrowthAppShell({ children }: { children: React.ReactNode }) {
  return (
    <PageShell className="space-y-4 sm:space-y-5">
      <PageHeader
        title="رشد و بازاریابی"
        description="برنامهٔ نگه‌داشتن و رشد مشتریان: میز کار، کمپین‌ها و کارت هدیه، وفاداری و پورسانت فروشندگان."
        actions={
          <>
            {/* No `section`: this header serves every Growth sub-page, so the
                button resolves the current route (home / loyalty / …) itself. */}
            <KnowledgeHelpButton />
            <AskAssistant
              app="growth"
              context="وضعیت بازاریابی را بررسی کن: کمپین‌های فعال، تخفیف مصرفی سی روز گذشته، مانده کارت هدیه و اعتبار فروشگاهی، و پورسانت فروشندگان."
            />
          </>
        }
      />
      <div className="min-w-0">{children}</div>
    </PageShell>
  );
}
