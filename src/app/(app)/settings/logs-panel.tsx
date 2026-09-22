"use client";

/**
 * Logs panel (Section 9/12 of the desktop audit): the "Logs" entry the
 * unified Settings Center needs. Surfaces this browser's recorded client
 * errors (error-report.ts's ring buffer, written by error.tsx/global-error.tsx
 * whenever a render error happens) with a one-click export, and — on the
 * desktop app — a shortcut to reveal the process-level log file
 * (electron/logger.js) in the OS file explorer, so "logs" means one place to
 * look whether the failure was in this page or in the desktop shell/Postgres
 * bootstrap that runs before any page exists.
 */
import { useEffect, useState } from "react";
import { DownloadIcon, FolderOpenIcon } from "lucide-react";
import { exportClientErrorLog } from "@/lib/error-report";
import { EmptyState, SectionCard } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { InfoBox } from "@/app/dashboard/ui";

export function LogsPanel() {
  const [hasEntries, setHasEntries] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [desktopNotice, setDesktopNotice] = useState("");

  useEffect(() => {
    setHasEntries(Boolean(exportClientErrorLog()));
    setIsDesktop(Boolean(window.businessSuiteDesktop?.isDesktop));
  }, []);

  function downloadBrowserLog() {
    const content = exportClientErrorLog();
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pos-browser-error-log-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function openDesktopLogs() {
    setDesktopNotice("");
    try {
      const path = await window.businessSuiteDesktop?.localGateway.openLogs();
      setDesktopNotice(path ? `پوشهٔ گزارش‌ها باز شد: ${path}` : "پوشهٔ گزارش‌ها باز شد.");
    } catch {
      setDesktopNotice("بازکردن پوشهٔ گزارش‌ها ممکن نشد.");
    }
  }

  return (
    <div className="space-y-5">
      <SectionCard
        title="گزارش خطاهای این مرورگر"
        description="خطاهایی که هنگام نمایش صفحات در همین مرورگر ثبت شده‌اند — شناسهٔ خطا و جزئیات فنی، بدون اطلاعات حساس."
      >
        <div className="p-4 sm:p-5">
          {hasEntries ? (
            <Button type="button" variant="outline" onClick={downloadBrowserLog}>
              <DownloadIcon aria-hidden="true" />
              دریافت فایل گزارش خطاها
            </Button>
          ) : (
            <EmptyState>هیچ خطایی در این مرورگر ثبت نشده است.</EmptyState>
          )}
        </div>
      </SectionCard>

      {isDesktop ? (
        <SectionCard
          title="گزارش‌های برنامهٔ دسکتاپ"
          description="گزارش کامل سرور محلی، دیتابیس و درگاه شبکه — برای اشتراک‌گذاری با پشتیبانی."
        >
          <div className="space-y-3 p-4 sm:p-5">
            {desktopNotice ? <InfoBox>{desktopNotice}</InfoBox> : null}
            <Button type="button" variant="outline" onClick={() => void openDesktopLogs()}>
              <FolderOpenIcon aria-hidden="true" />
              بازکردن پوشهٔ گزارش‌ها
            </Button>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
