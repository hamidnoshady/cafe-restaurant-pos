"use client";

/**
 * The Growth app shell (Phase 36b, revised).
 *
 * Wraps every Growth route. The dashboard's global sidebar already names the app
 * (رشد و بازاریابی); this shell adds the app's *own* side menu and a header,
 * so entering `/dashboard/growth` feels like entering a separate product with
 * its own navigation — not a corner of accounting. The bridge to accounting is
 * deliberately not surfaced here: the work passes through the ledger in the
 * backend, and the app shows only its own numbers.
 */

import { PageHeader } from "../page-chrome";
import { AskAssistant } from "@/components/ai/ask-assistant";
import { GrowthSideNav } from "./growth-side-nav";

export function GrowthAppShell({
  role,
  children,
}: {
  role: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        title="رشد و بازاریابی"
        description="برنامهٔ نگه‌داشتن و رشد مشتریان: میز کار، کمپین‌ها و کارت هدیه، وفاداری و پورسانت فروشندگان."
        actions={
          <AskAssistant
            app="growth"
            context="وضعیت بازاریابی را بررسی کن: کمپین‌های فعال، تخفیف مصرفی سی روز گذشته، مانده کارت هدیه و اعتبار فروشگاهی، و پورسانت فروشندگان."
          />
        }
      />
      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="lg:sticky lg:top-4 lg:self-start">
          <GrowthSideNav role={role} />
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
