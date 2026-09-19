"use client";

/**
 * The connector gate — the one thing standing between the operator and
 * hardware printing. The Cafe POS Windows Print Connector (a small
 * dependency-free helper on the cashier's own computer) owns every printer
 * this machine can reach: Windows queues AND network printers. When it is
 * missing or outdated, the flow says so in one plain card with a one-click
 * install — no mention of agents, ports or protocols.
 */
import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { printerErrorMessage, type PrinterErrorCode } from "@/lib/printing/errors";

export type ConnectorState = "checking" | "down" | "ready";

/**
 * «اتصال این کامپیوتر» — the install card shown when hardware printing
 * needs the connector and it is not there (or is an older version).
 */
export function ConnectorInstallCard({ error, onRecheck, rechecking }: {
  error: PrinterErrorCode | null;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  return (
    <SectionCard title="اتصال این کامپیوتر" description="کافه‌پوز برای دسترسی به چاپگرها به یک رابط چاپ کوچک روی همین کامپیوتر نیاز دارد.">
      <div className="space-y-3">
        <p className="text-sm leading-6 text-muted-foreground">
          {printerErrorMessage(error ?? "connector_not_installed")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild>
            <a href="/api/printing/connector/installer" download>
              <DownloadIcon aria-hidden="true" />
              نصب رابط چاپ
            </a>
          </Button>
          <Button type="button" variant="outline" onClick={onRecheck} disabled={rechecking}>
            {rechecking ? "در حال بررسی…" : "بررسی دوباره"}
          </Button>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          فایل دانلودشده را باز کنید و تأیید Windows را بزنید؛ نصب خودکار است، به Node.js یا دستور خاصی نیاز ندارد و از ورودهای بعدی
          Windows هم خودکار اجرا می‌شود. پس از پیام موفقیت، «بررسی دوباره» را بزنید.
        </p>
      </div>
    </SectionCard>
  );
}
