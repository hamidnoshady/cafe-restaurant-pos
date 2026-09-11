"use client";

import { useState } from "react";
import { FileSpreadsheetIcon, FileTextIcon, TableIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { triggerExport, type ExportRequest } from "./report-ui";

const FORMATS = [
  { format: "csv", label: "خروجی CSV", Icon: TableIcon },
  { format: "excel", label: "خروجی Excel", Icon: FileSpreadsheetIcon },
  { format: "pdf", label: "خروجی PDF", Icon: FileTextIcon },
] as const satisfies readonly { format: ExportRequest["format"]; label: string; Icon: typeof TableIcon }[];

/**
 * The three export formats for whatever report is on screen.
 *
 * Each button used to restate `min-h-[52px] border-border/80 bg-card …` on top
 * of `variant="outline" size="lg"`, which is the same skin the variant already
 * supplies — three copies of a control style that would have to be found again
 * at the next restyle. The variant carries it now, and the three buttons are
 * one map over a table rather than three near-identical blocks.
 */
export function ExportButtons({ request }: { request: Omit<ExportRequest, "format"> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function run(format: ExportRequest["format"]) {
    setBusy(format);
    setError("");
    const nextError = await triggerExport({ ...request, format });
    if (nextError) setError(nextError);
    setBusy(null);
  }

  return (
    <div className="flex flex-wrap items-center gap-2" aria-busy={busy !== null}>
      {FORMATS.map(({ format, label, Icon }) => (
        <Button
          key={format}
          type="button"
          variant="outline"
          size="lg"
          onClick={() => run(format)}
          disabled={busy !== null}
        >
          <Icon aria-hidden="true" />
          {busy === format ? "در حال آماده‌سازی…" : label}
        </Button>
      ))}
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
