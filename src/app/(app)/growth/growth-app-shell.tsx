"use client";

/**
 * The Growth app shell (Phase 36b, revised again).
 *
 * Wraps every Growth route with the app's own header. Its side menu used to be
 * drawn here too, beside the content, *inside* the dashboard's sidebar — which
 * still showed the business's flat nav, accounting included. That made the app
 * look like a page of accounting with a sub-menu of its own.
 *
 * The app now owns the sidebar itself: `src/lib/app-shells.ts` hands the slot to
 * `growth/growth-app-nav.tsx` for every route under `/growth`, so this
 * shell is the header and the page, at the width the rest of the dashboard uses.
 * The bridge to accounting is deliberately not surfaced here either: the work
 * passes through the ledger in the backend, and the app shows only its own
 * numbers.
 */

import { usePathname } from "next/navigation";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { GROWTH_SETTINGS_HREF } from "./growth-routes";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { AskAssistant } from "@/components/ai/ask-assistant";

/**
 * The app's settings page gets its own title and description, so it can never
 * be mistaken for — or quietly replaced by — the platform settings page. Every
 * other section keeps the app's own heading.
 */
const APP_HEADING = {
  title: "رشد و بازاریابی",
  description:
    "برنامهٔ نگه‌داشتن و رشد مشتریان: میز کار، کمپین‌ها و کارت هدیه، وفاداری و پورسانت فروشندگان.",
};

const SETTINGS_HEADING = {
  title: "تنظیمات رشد و بازاریابی",
  description:
    "تنظیمات مخصوص همین برنامه — وفاداری، کمپین‌ها، پیام‌رسانی و پورسانت. تنظیمات کسب‌وکار و پلتفرم جای دیگری است.",
};

export function GrowthAppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const heading = pathname === GROWTH_SETTINGS_HREF ? SETTINGS_HEADING : APP_HEADING;

  return (
    <PageShell className="space-y-4 sm:space-y-5">
      <PageHeader
        title={heading.title}
        description={heading.description}
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
