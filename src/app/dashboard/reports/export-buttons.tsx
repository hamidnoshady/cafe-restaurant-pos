"use client";

import { useState } from "react";
import { SecondaryButton } from "../ui";
import { triggerExport, type ExportRequest } from "./report-ui";

export function ExportButtons({ request }: { request: Omit<ExportRequest, "format"> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function run(format: ExportRequest["format"]) {
    setBusy(format);
    setError("");
    const err = await triggerExport({ ...request, format });
    if (err) setError(err);
    setBusy(null);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SecondaryButton onClick={() => run("csv")} disabled={busy !== null}>
        {busy === "csv" ? "در حال آماده‌سازی…" : "خروجی CSV"}
      </SecondaryButton>
      <SecondaryButton onClick={() => run("excel")} disabled={busy !== null}>
        {busy === "excel" ? "در حال آماده‌سازی…" : "خروجی Excel"}
      </SecondaryButton>
      <SecondaryButton onClick={() => run("pdf")} disabled={busy !== null}>
        {busy === "pdf" ? "در حال آماده‌سازی…" : "خروجی PDF"}
      </SecondaryButton>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
