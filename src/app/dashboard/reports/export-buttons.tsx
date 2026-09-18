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
export function ExportButtons({
  request,
  disabled = false,
}: {
  request: Omit<ExportRequest, "format">;
  /**
   * There is nothing worth exporting yet — the report is still loading, failed,
   * or was never run. Without this the buttons stayed live over an empty result
   * and produced a file with a header row and no data, which reads as a report
   * saying the business did nothing rather than as a report that never ran.
   */
  disabled?: boolean;
}) {
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
          disabled={disabled || busy !== null}
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
