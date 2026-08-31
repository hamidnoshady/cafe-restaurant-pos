"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

/**
 * The Growth app's commission section (Phase 36b) — the old
 * /dashboard/commission page as a section. Unchanged in substance: each line
 * accrues to the employee whose rule is most specific (item beats brand beats
 * category beats everything), a margin-basis rule uses the same cost the COGS
 * posting used so commission can never disagree with the ledger, and the
 * moment a line accrues, «پورسانت فروش» (۵۲۱۰) is debited and «حقوق پرداختنی»
 * (۲۳۰۰) credited through the same domain-event engine every other
 * auto-posting uses.
 */

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { cardClass, EmptyState, SectionCard, StatusBadge } from "../page-chrome";
import { api, ErrorBox, Field, InfoBox, inputClass } from "../ui";

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

export function CommissionSection() {
  const money = useMoney();
  const [rules, setRules] = useState<CommissionRuleRow[] | null>(null);
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

  if (!rules) {
    return (
      <SectionCardSkeleton rows={4} />
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>
      {done ? <InfoBox>{done}</InfoBox> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <RuleForm
          staff={staff}
          onSaved={(m) => {
            setDone(m);
            load();
          }}
          onError={setError}
        />
        <SectionCard title="رتبه‌بندی فروشندگان" description="مجموع پورسانت انباشته — همان عددی که به‌عنوان بدهی حقوق ثبت شده است">
          {report.length === 0 ? (
            <EmptyState>هنوز پورسانتی ثبت نشده است.</EmptyState>
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
        </SectionCard>
      </div>

      <SectionCard title="قوانین پورسانت">
        {rules.length === 0 ? (
          <EmptyState>هنوز قانونی تعریف نشده است.</EmptyState>
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
                <StatusBadge tone={r.isActive ? "positive" : "neutral"}>{r.isActive ? "فعال" : "غیرفعال"}</StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
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
    <SectionCard title="قانون جدید" bodyClassName="space-y-3 p-4 sm:p-5">
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
            <PersianNumberInput
              inputMode={kind === "percent" ? "decimal" : "numeric"}
              className={inputClass}
              dir="ltr"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
          </Field>
        </div>
        <Field label="مبنا">
          <select className={inputClass} value={basis} onChange={(e) => setBasis(e.target.value as "net" | "margin")}>
            <option value="net">{BASIS_LABELS.net}</option>
            <option value="margin">{BASIS_LABELS.margin}</option>
          </select>
        </Field>
        <Field label="اولویت (بیشتر = زودتر)">
          <PersianNumberInput
            inputMode="numeric"
            className={inputClass}
            dir="ltr"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={busy} className="min-h-11 w-full">
          ذخیره قانون
        </Button>
      </form>
    </SectionCard>
  );
}
