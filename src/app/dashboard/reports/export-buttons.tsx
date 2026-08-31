"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { triggerExport, type ExportRequest } from "./report-ui";

export function ExportButtons({
  request,
}: {
  request: Omit<ExportRequest, "format">;
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
    <div
      className="flex flex-wrap items-center gap-2"
      aria-busy={busy !== null}
    >
      <Button
        type="button"
        variant="outline"
        size="lg"
        onClick={() => run("csv")}
        disabled={busy !== null}
        className="min-h-[52px] border-border/80 bg-card px-4 text-foreground hover:bg-muted"
      >
        {busy === "csv" ? "در حال آماده‌سازی…" : "خروجی CSV"}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="lg"
        onClick={() => run("excel")}
        disabled={busy !== null}
        className="min-h-[52px] border-border/80 bg-card px-4 text-foreground hover:bg-muted"
      >
        {busy === "excel" ? "در حال آماده‌سازی…" : "خروجی Excel"}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="lg"
        onClick={() => run("pdf")}
        disabled={busy !== null}
        className="min-h-[52px] border-border/80 bg-card px-4 text-foreground hover:bg-muted"
      >
        {busy === "pdf" ? "در حال آماده‌سازی…" : "خروجی PDF"}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
