"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { triggerExport, type ExportRequest } from "./report-ui";

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
      <Button
        type="button"
        variant="outline"
        size="lg"
        onClick={() => run("csv")}
        disabled={busy !== null}
        className="min-h-12 border-[#DEDAD2] bg-white px-4 text-[#252522] hover:bg-[#FCFBF8]"
      >
        {busy === "csv" ? "در حال آماده‌سازی…" : "خروجی CSV"}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="lg"
        onClick={() => run("excel")}
        disabled={busy !== null}
        className="min-h-12 border-[#DEDAD2] bg-white px-4 text-[#252522] hover:bg-[#FCFBF8]"
      >
        {busy === "excel" ? "در حال آماده‌سازی…" : "خروجی Excel"}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="lg"
        onClick={() => run("pdf")}
        disabled={busy !== null}
        className="min-h-12 border-[#DEDAD2] bg-white px-4 text-[#252522] hover:bg-[#FCFBF8]"
      >
        {busy === "pdf" ? "در حال آماده‌سازی…" : "خروجی PDF"}
      </Button>
      {error ? <span role="alert" className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
