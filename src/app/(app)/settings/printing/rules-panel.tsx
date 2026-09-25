"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BUILT_IN_TEMPLATES } from "@/lib/print-template";
import { LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";
import { ErrorBox, api, inputClass } from "@/app/dashboard/ui";

const DOCS = [
  { key: "receipt", label: "رسید فروش" },
  { key: "kitchen", label: "فیش آشپزخانه" },
  { key: "invoice", label: "فاکتور" },
  { key: "label", label: "برچسب" },
] as const;

interface RuleRow {
  document_type: string;
  template_key: string | null;
  printer_id: string | null;
  fallback_printer_id: string | null;
}

interface PrinterOption {
  id: string;
  name: string;
  kind: string;
}

interface HistoryRow {
  id: string;
  documentType: string;
  status: string;
  printerName: string | null;
  when: string;
}

const STATUS_LABEL: Record<string, string> = {
  handed_off: "ارسال شد",
  sending: "در حال ارسال",
  failed: "ناموفق",
};

export function RulesPanel() {
  const [rules, setRules] = useState<Record<string, RuleRow>>({});
  const [printers, setPrinters] = useState<PrinterOption[]>([]);
  const [jobs, setJobs] = useState<HistoryRow[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const [ruleRes, printerRes, jobRes] = await Promise.all([
        api<{ rules?: RuleRow[] }>("/api/settings/print-rules"),
        api<{ printers?: PrinterOption[] }>("/api/settings/printers"),
        api<{ jobs?: HistoryRow[] }>("/api/printing/jobs"),
      ]);
      if (!ruleRes.ok) setError("قوانین چاپ خوانده نشد.");
      const next: Record<string, RuleRow> = {};
      for (const row of ruleRes.data.rules ?? []) next[row.document_type] = row;
      setRules(next);
      if (printerRes.ok) setPrinters(printerRes.data.printers ?? []);
      if (jobRes.ok) setJobs(jobRes.data.jobs ?? []);
      setLoading(false);
    })();
  }, []);

  async function save(documentType: string) {
    const row = rules[documentType];
    setSaving(documentType);
    setError("");
    const { ok } = await api("/api/settings/print-rules", {
      method: "PUT",
      body: JSON.stringify({
        documentType,
        templateKey: row?.template_key ?? null,
        printerId: row?.printer_id ?? null,
        fallbackPrinterId: row?.fallback_printer_id ?? null,
      }),
    });
    setSaving(null);
    if (!ok) setError("ذخیرهٔ قانون چاپ ناموفق بود.");
  }

  function patch(documentType: string, patchRow: Partial<RuleRow>) {
    setRules((current) => ({
      ...current,
      [documentType]: {
        document_type: documentType,
        template_key: current[documentType]?.template_key ?? null,
        printer_id: current[documentType]?.printer_id ?? null,
        fallback_printer_id: current[documentType]?.fallback_printer_id ?? null,
        ...patchRow,
      },
    }));
  }

  if (loading) return <LoadingSkeleton rows={4} />;

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {DOCS.map((doc) => (
        <SectionCard key={doc.key} title={doc.label}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">قالب</span>
              <select
                className={inputClass}
                value={rules[doc.key]?.template_key ?? ""}
                onChange={(event) => patch(doc.key, { template_key: event.target.value || null })}
              >
                <option value="">قالب پیش‌فرض</option>
                {BUILT_IN_TEMPLATES.filter((template) => template.docType === (doc.key === "invoice" ? "invoice" : doc.key === "kitchen" ? "kitchen" : doc.key === "label" ? "label" : "receipt")).map((template) => (
                  <option key={template.key} value={template.key}>{template.name}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">چاپگر</span>
              <select
                className={inputClass}
                value={rules[doc.key]?.printer_id ?? ""}
                onChange={(event) => patch(doc.key, { printer_id: event.target.value || null })}
              >
                <option value="">انتخاب نشده</option>
                {printers.map((printer) => (
                  <option key={printer.id} value={printer.id}>{printer.name}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-3">
            <Button type="button" disabled={saving === doc.key} onClick={() => void save(doc.key)}>
              {saving === doc.key ? "در حال ذخیره…" : "ذخیره"}
            </Button>
          </div>
        </SectionCard>
      ))}
      <SectionCard title="فعالیت اخیر" description="آخرین ارسال‌ها به چاپگر. «ارسال شد» یعنی ویندوز کار را پذیرفته است.">
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز چاپی ثبت نشده است.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {jobs.map((job) => (
              <li key={job.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>{job.when}</span>
                <span dir="auto">{job.printerName ?? "—"}</span>
                <span>{STATUS_LABEL[job.status] ?? job.status}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
