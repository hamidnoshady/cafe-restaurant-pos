"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
import { kickDrawer, testPrint } from "@/lib/print-agent-client";
import type { PrinterConnection } from "@/lib/printer-connection";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ErrorBox, Field, InfoBox, PrimaryButton, SecondaryButton, api, errorMessage, inputClass } from "../ui";
import { SectionCard } from "../page-chrome";

interface Printer {
  id: string;
  name: string;
  kind: "receipt" | "kitchen";
  connection: PrinterConnection;
  is_active: boolean;
}

interface PrinterDraft {
  name: string;
  kind: "receipt" | "kitchen";
  ip: string;
  port: string;
  paperWidthMm: "58" | "80";
  isActive: boolean;
  isDefault: boolean;
}

const EMPTY: PrinterDraft = { name: "", kind: "receipt", ip: "", port: "9100", paperWidthMm: "80", isActive: true, isDefault: false };

function toDraft(printer: Printer): PrinterDraft {
  return {
    name: printer.name,
    kind: printer.kind,
    ip: printer.connection?.ip ?? "",
    port: String(printer.connection?.port ?? 9100),
    paperWidthMm: printer.connection?.paperWidthMm === 58 ? "58" : "80",
    isActive: printer.is_active,
    isDefault: printer.connection?.isDefault === true,
  };
}

function payload(draft: PrinterDraft) {
  return {
    name: draft.name,
    kind: draft.kind,
    ip: draft.ip,
    port: Number(draft.port),
    paperWidthMm: Number(draft.paperWidthMm),
    isActive: draft.isActive,
    isDefault: draft.isDefault,
  };
}

/** Branch hardware pairing and per-printer operational settings. */
export function PrinterSettings() {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [draft, setDraft] = useState<PrinterDraft>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<{ printers: Printer[]; error?: string }>("/api/settings/printers");
    if (ok) {
      setPrinters(data.printers);
      setError("");
    } else {
      setError(errorMessage(data.error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ error?: string }>("/api/settings/printers", { method: "POST", body: JSON.stringify(payload(draft)) });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setDraft(EMPTY);
    setNotice("چاپگر جدید ثبت شد.");
    await load();
  }

  async function update(printer: Printer, next: PrinterDraft) {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ error?: string }>(`/api/settings/printers/${printer.id}`, { method: "PATCH", body: JSON.stringify(payload(next)) });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return false;
    }
    setNotice("تنظیمات چاپگر ذخیره شد.");
    await load();
    return true;
  }

  async function remove(printer: Printer) {
    if (!window.confirm(`چاپگر «${printer.name}» حذف شود؟`)) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>(`/api/settings/printers/${printer.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice("چاپگر حذف شد.");
    await load();
  }

  async function agentAction(printer: Printer, action: "print" | "drawer") {
    setError("");
    setNotice("");
    const result = action === "print" ? await testPrint(printer.connection, printer.kind) : await kickDrawer(printer.connection);
    if (!result.ok) {
      setError(result.unreachable ? "عامل چاپ محلی در دسترس نیست؛ آن را روی دستگاه صندوق اجرا و اتصال شبکه را بررسی کنید." : "فرمان چاپگر با خطا روبه‌رو شد.");
      return;
    }
    setNotice(action === "print" ? "فرمان چاپ آزمایشی ارسال شد." : "فرمان بازشدن کشوی پول ارسال شد.");
  }

  if (loading) return <LoadingSkeleton rows={3} />;

  return (
    <div className="space-y-6">
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <SectionCard title="افزودن چاپگر">
        <p className="mb-4 text-sm text-muted-foreground">چاپگرهای رسید و آشپزخانه را به شعبهٔ فعال وصل کنید. عامل چاپ محلی باید روی دستگاه صندوق اجرا باشد.</p>
        <PrinterForm value={draft} onChange={setDraft} onSubmit={create} submitLabel="افزودن چاپگر" busy={busy} />
      </SectionCard>

      <section className="space-y-4">
        <div>
          <h2 className="font-semibold">چاپگرهای این شعبه</h2>
          <p className="mt-1 text-sm text-muted-foreground">هر نوع چاپگر می‌تواند یک چاپگر پیش‌فرض داشته باشد؛ صندوق از آن برای چاپ خودکار استفاده می‌کند.</p>
        </div>
        {printers.length === 0 ? <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">هنوز چاپگری ثبت نشده است.</p> : null}
        {printers.map((printer) => <PrinterCard key={printer.id} printer={printer} busy={busy} onSave={update} onDelete={remove} onAgentAction={agentAction} />)}
      </section>
    </div>
  );
}

function PrinterForm({ value, onChange, onSubmit, submitLabel, busy }: { value: PrinterDraft; onChange: (value: PrinterDraft) => void; onSubmit: (event: React.FormEvent) => void; submitLabel: string; busy: boolean }) {
  function change<K extends keyof PrinterDraft>(key: K, next: PrinterDraft[K]) {
    onChange({ ...value, [key]: next });
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-x-4 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="نام چاپگر">
        <input className={inputClass} value={value.name} onChange={(e) => change("name", e.target.value)} placeholder="مثلاً چاپگر صندوق" required />
      </Field>
      <Field label="نوع چاپگر">
        <SearchableSelect
          value={value.kind}
          onChange={(next) => change("kind", next === "kitchen" ? "kitchen" : "receipt")}
          options={[
            { value: "receipt", label: "رسید مشتری" },
            { value: "kitchen", label: "آشپزخانه" },
          ]}
        />
      </Field>
      <Field label="IP شبکه">
        <input className={inputClass} dir="ltr" value={value.ip} onChange={(e) => change("ip", e.target.value)} placeholder="192.168.1.50" required />
      </Field>
      <Field label="پورت">
        <PersianNumberInput
          className={inputClass}
          dir="ltr"
          inputMode="numeric"
          grouping={false}
          allowNegative={false}
          value={value.port}
          onChange={(e) => change("port", e.target.value)}
          required
        />
      </Field>
      <Field label="عرض کاغذ">
        <SearchableSelect
          value={value.paperWidthMm}
          onChange={(next) => change("paperWidthMm", next === "58" ? "58" : "80")}
          options={[
            { value: "80", label: "۸۰ میلی‌متر" },
            { value: "58", label: "۵۸ میلی‌متر" },
          ]}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-4 pb-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={value.isActive} onChange={(e) => change("isActive", e.target.checked)} />فعال</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={value.isDefault} onChange={(e) => change("isDefault", e.target.checked)} />پیش‌فرض این نوع</label>
      </div>
      <div className="sm:col-span-2 lg:col-span-3 max-w-xs"><PrimaryButton disabled={busy}>{busy ? "در حال ذخیره…" : submitLabel}</PrimaryButton></div>
    </form>
  );
}

function PrinterCard({ printer, busy, onSave, onDelete, onAgentAction }: { printer: Printer; busy: boolean; onSave: (printer: Printer, value: PrinterDraft) => Promise<boolean>; onDelete: (printer: Printer) => Promise<void>; onAgentAction: (printer: Printer, action: "print" | "drawer") => Promise<void> }) {
  const [value, setValue] = useState(() => toDraft(printer));

  useEffect(() => {
    setValue(toDraft(printer));
  }, [printer]);

  return (
    <SectionCard>
      <PrinterForm value={value} onChange={setValue} onSubmit={(event) => { event.preventDefault(); void onSave(printer, value); }} submitLabel="ذخیرهٔ چاپگر" busy={busy} />
      <div className="mt-4 flex flex-wrap gap-2 border-t border-border/80 pt-4">
        <SecondaryButton disabled={busy} onClick={() => void onAgentAction({ ...printer, kind: value.kind, connection: { ...printer.connection, ip: value.ip, port: Number(value.port), paperWidthMm: Number(value.paperWidthMm) as 58 | 80 } }, "print")}>چاپ آزمایشی</SecondaryButton>
        {value.kind === "receipt" ? <SecondaryButton disabled={busy} onClick={() => void onAgentAction({ ...printer, kind: value.kind, connection: { ...printer.connection, ip: value.ip, port: Number(value.port), paperWidthMm: Number(value.paperWidthMm) as 58 | 80 } }, "drawer")}>آزمایش کشوی پول</SecondaryButton> : null}
        <SecondaryButton disabled={busy} onClick={() => void onDelete(printer)}>حذف چاپگر</SecondaryButton>
      </div>
    </SectionCard>
  );
}
