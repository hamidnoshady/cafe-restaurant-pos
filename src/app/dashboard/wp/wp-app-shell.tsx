/**
 * The WordPress & WooCommerce Manager app shell.
 *
 * Wraps every `/dashboard/wp` route with the app's own header. The
 * side menu itself is rendered by `wp-app-nav.tsx` through
 * `src/lib/app-shells.ts` — the same split the CRM and Growth apps use.
 */
import { PageHeader, PageShell } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
import { AskAssistant } from "@/components/ai/ask-assistant";

export function WpAppShell({ children }: { children: React.ReactNode }) {
  return (
    <PageShell className="space-y-4 sm:space-y-5">
      <PageHeader
        title="مدیریت وردپرس و ووکامرس"
        description="مدیریت کامل فروشگاه آنلاین: محصولات، سفارش‌ها، مشتریان، دسته‌بندی‌ها، محتوا و رسانه‌های سایت — به‌همراه وضعیت اتصال و صف همگام‌سازی."
        actions={
          <>
            <KnowledgeHelpButton section="connections" />
            <AskAssistant
              app="wp"
              context="وضعیت فروشگاه آنلاین را بررسی کن: اتصال وردپرس/ووکامرس، آخرین همگام‌سازی محصولات، سفارش‌ها و مشتریان، رویدادهای ناموفق در صف، و تعداد نوشته‌ها و رسانه‌های همگام‌شده."
            />
          </>
        }
      />
      <div className="min-w-0">{children}</div>
    </PageShell>
  );
}
