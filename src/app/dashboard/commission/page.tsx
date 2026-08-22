"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { api, ErrorBox, Field, inputClass } from "../ui";

interface CommissionRuleRow {
  id: string;
  employeeId: string;
  employeeName: string | null;
  kind: "percent" | "fixed";
  basis: "net" | "margin";
  value: number;
  itemIds: string[] | null;
  brandIds: string[] | null;
  categoryIds: string[] | null;
  priority: number;
  isActive: boolean;
}

interface StaffMember {
  id: string;
  fullName: string;
}

interface ReportRow {
  employeeId: string;
  employeeName: string;
  amount: number;
  basisAmount: number;
  lineCount: number;
}

const BASIS_LABELS: Record<string, string> = {
  net: "روی مبلغ خط",
  margin: "روی سود (مبلغ خط منهای بهای تمام‌شده)",
};

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgb(41_37_36/0.035)] sm:p-5">
      <h2 className="font-semibold text-stone-950">{title}</h2>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

export default function CommissionPage() {
  const money = useMoney();
  const [rules, setRules] = useState<CommissionRuleRow[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [report, setReport] = useState<ReportRow[]>([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const load = useCallback(() => {
    api<{ rules: CommissionRuleRow[]; staff: StaffMember[] }>("/api/commission/rules").then(({ ok, data }) => {
      if (ok) {
        setRules(data.rules);
        setStaff(data.staff);
      }
    });
    api<{ report: ReportRow[] }>("/api/commission/report").then(({ ok, data }) => ok && setReport(data.report));
  }, []);
  useEffect(load, [load]);

  return (
    <div className="mx-auto w-full max-w-[1100px]">
      <header className="mb-5 border-b border-stone-200/80 pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-stone-950">پورسانت فروشندگان</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          هر خطِ فاکتور به فروشندهٔ خودش پورسانت می‌دهد و به‌صورت بدهی حقوق (۲۳۰۰) ثبت می‌شود، نه فقط یک گزارش.
        </p>
      </header>

      <ErrorBox>{error}</ErrorBox>
      {done ? <p className="mb-3 text-xs text-emerald-700">{done}</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <RuleForm
          staff={staff}
          onSaved={(m) => {
            setDone(m);
            load();
          }}
          onError={setError}
        />
        <Panel title="رتبه‌بندی فروشندگان">
          {report.length === 0 ? (
            <p className="rounded-xl border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-muted-foreground">
              هنوز پورسانتی ثبت نشده است.
            </p>
          ) : (
            <ul className="divide-y divide-stone-200/80 text-sm">
              {report.map((r, i) => (
                <li key={r.employeeId} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <span className="font-medium text-stone-950">
                      {formatPersianNumber(i + 1)}. {r.employeeName}
                    </span>
                    <span className="mr-2 text-xs text-muted-foreground">
                      {formatPersianNumber(r.lineCount)} خط · مبنا {money.format(r.basisAmount)}
                    </span>
                  </div>
                  <span className="shrink-0 font-semibold text-emerald-700">{money.format(r.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="mt-4">
        <Panel title="قوانین پورسانت">
          {rules.length === 0 ? (
            <p className="rounded-xl border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-muted-foreground">
              هنوز قانونی تعریف نشده است.
            </p>
          ) : (
            <ul className="divide-y divide-stone-200/80 text-sm">
              {rules.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <span className="font-medium text-stone-950">{r.employeeName ?? "نامشخص"}</span>
                    <span className="mr-2 text-xs text-muted-foreground">
                      {r.kind === "percent" ? `${formatPersianNumber(r.value)}٪` : money.format(r.value)} ·{" "}
                      {BASIS_LABELS[r.basis]} · اولویت {formatPersianNumber(r.priority)}
                    </span>
                  </div>
                  <span className={`shrink-0 text-xs ${r.isActive ? "text-emerald-700" : "text-stone-400"}`}>
                    {r.isActive ? "فعال" : "غیرفعال"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

function RuleForm({
  staff,
  onSaved,
  onError,
}: {
  staff: StaffMember[];
  onSaved: (m: string) => void;
  onError: (m: string) => void;
}) {
  const money = useMoney();
  const [employeeId, setEmployeeId] = useState("");
  const [kind, setKind] = useState<"percent" | "fixed">("percent");
  const [basis, setBasis] = useState<"net" | "margin">("net");
  const [value, setValue] = useState("");
  const [priority, setPriority] = useState("0");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!employeeId || !value.trim()) return;
    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string }>("/api/commission/rules", {
      method: "POST",
      body: JSON.stringify({
        employeeId,
        kind,
        basis,
        value: kind === "percent" ? Number(value) : money.parse(value),
        priority: Number(priority) || 0,
      }),
    });
    setBusy(false);
    if (!ok) onError(data.message ?? "ثبت قانون پورسانت ناموفق بود.");
    else {
      setValue("");
      onSaved("قانون پورسانت ذخیره شد.");
    }
  }

  return (
    <Panel title="قانون جدید">
      <form onSubmit={submit} className="grid gap-3">
        <Field label="فروشنده">
          <select className={inputClass} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required>
            <option value="">انتخاب کنید…</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.fullName}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="نوع">
            <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as "percent" | "fixed")}>
              <option value="percent">درصدی</option>
              <option value="fixed">مبلغ ثابت ({money.unitLabel})</option>
            </select>
          </Field>
          <Field label={kind === "percent" ? "درصد" : `مبلغ (${money.unitLabel})`}>
            <input className={inputClass} dir="ltr" value={value} onChange={(e) => setValue(e.target.value)} required />
          </Field>
        </div>
        <Field label="مبنا">
          <select className={inputClass} value={basis} onChange={(e) => setBasis(e.target.value as "net" | "margin")}>
            <option value="net">{BASIS_LABELS.net}</option>
            <option value="margin">{BASIS_LABELS.margin}</option>
          </select>
        </Field>
        <Field label="اولویت (بیشتر = زودتر)">
          <input className={inputClass} dir="ltr" value={priority} onChange={(e) => setPriority(e.target.value)} />
        </Field>
        <Button type="submit" disabled={busy} className="min-h-11 w-full">
          ذخیره قانون
        </Button>
      </form>
    </Panel>
  );
}
