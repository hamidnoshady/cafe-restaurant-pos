"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api, Field, inputClass } from "../ui";
import { ItemAuditPanel } from "../item-audit-panel";
import {
  SERIAL_STATUS_LABELS,
  type Runner,
  type SerialUnit,
  type WatchModel,
} from "./watch-manager";

const watchInputClass = `${inputClass} min-h-[52px] !border-stone-200 !bg-white shadow-none placeholder:text-stone-400 focus-visible:border-amber-500 focus-visible:ring-amber-400/30`;
const secondaryActionClass =
  "min-h-[44px] border-stone-200 bg-white px-3 text-xs text-stone-700 hover:border-amber-300 hover:bg-amber-50 hover:text-stone-950 focus-visible:border-amber-500 focus-visible:ring-amber-400/30";

const STATUS_BADGE_CLASS: Record<SerialUnit["status"], string> = {
  in_stock: "bg-emerald-100 text-emerald-900",
  reserved: "bg-amber-100 text-amber-900",
  in_repair: "bg-sky-100 text-sky-900",
  sold: "bg-stone-200 text-stone-600",
};

export function UnitsSection({
  models,
  units,
  busy,
  run,
}: {
  models: WatchModel[];
  units: SerialUnit[];
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const [modelName, setModelName] = useState("");
  const [modelSku, setModelSku] = useState("");
  const [serviceIntervalMonths, setServiceIntervalMonths] = useState("");
  const [itemId, setItemId] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [warrantyMonths, setWarrantyMonths] = useState("12");

  async function addModel(e: React.FormEvent) {
    e.preventDefault();
    if (!modelName.trim()) return;
    const ok = await run(() =>
      api("/api/watch/items", {
        method: "POST",
        body: JSON.stringify({
          name: modelName,
          sku: modelSku.trim() || null,
          serviceIntervalMonths: serviceIntervalMonths.trim() ? Number(serviceIntervalMonths) : null,
        }),
      }),
    );
    if (ok) {
      setModelName("");
      setModelSku("");
      setServiceIntervalMonths("");
    }
  }

  async function addUnit(e: React.FormEvent) {
    e.preventDefault();
    if (!itemId || !serialNumber.trim()) return;
    const ok = await run(() =>
      api("/api/watch/units", {
        method: "POST",
        body: JSON.stringify({
          itemId,
          serialNumber,
          unitCost: unitCost.trim() ? money.fromInput(Math.max(0, Math.round(Number(unitCost)))) : null,
          warrantyMonths: Number(warrantyMonths || 0),
        }),
      }),
    );
    if (ok) {
      setSerialNumber("");
      setUnitCost("");
    }
  }

  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_18rem] lg:gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
      <section
        aria-labelledby="watch-units-heading"
        className="order-2 min-w-0 overflow-hidden rounded-2xl bg-card md:order-1"
      >
        <div className="border-b border-stone-200/80 px-4 py-4 sm:px-5">
          <h2 id="watch-units-heading" className="font-semibold text-stone-950">
            دستگاه‌های سریال‌دار
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            هر دستگاه با شماره سریال خودش ثبت می‌شود؛ گارانتی از لحظهٔ فروش شروع می‌شود.
          </p>
        </div>

        <ul className="divide-y divide-stone-200/80">
          {units.map((unit) => (
            <UnitRow key={unit.id} unit={unit} busy={busy} run={run} />
          ))}
          {units.length === 0 ? (
            <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">دستگاهی ثبت نشده است.</li>
          ) : null}
        </ul>
      </section>

      <aside className="order-1 min-w-0 space-y-4 md:order-2">
        <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgb(41_37_36/0.035)] sm:p-5">
          <h2 className="font-semibold text-stone-950">افزودن مدل</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            مدل، خودِ کالاست؛ دستگاه‌های فیزیکی زیر همان مدل ثبت می‌شوند.
          </p>
          <form onSubmit={addModel} className="mt-4">
            <Field label="نام مدل">
              <input
                className={watchInputClass}
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder="مثلاً کاسیو ادیفایس"
                required
              />
            </Field>
            <Field label="کد کالا">
              <input
                className={watchInputClass}
                value={modelSku}
                onChange={(e) => setModelSku(e.target.value)}
                placeholder="اختیاری"
              />
            </Field>
            <Field label="فاصلهٔ سرویس (ماه)" hint="باطری کوارتز ~۲۴، موتور اتوماتیک ۳۶ تا ۶۰. خالی = بدون یادآوری.">
              <input
                className={watchInputClass}
                dir="ltr"
                inputMode="numeric"
                value={serviceIntervalMonths}
                onChange={(e) => setServiceIntervalMonths(e.target.value)}
                placeholder="اختیاری"
              />
            </Field>
            <Button
              type="submit"
              disabled={busy}
              size="lg"
              className="min-h-[52px] w-full border border-amber-300 px-5 font-semibold focus-visible:ring-amber-400/30"
            >
              افزودن مدل
            </Button>
          </form>
        </div>

        <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgb(41_37_36/0.035)] sm:p-5">
          <h2 className="font-semibold text-stone-950">ثبت دستگاه</h2>
          <form onSubmit={addUnit} className="mt-4">
            <Field label="مدل">
              <SearchableSelect
                className={watchInputClass}
                value={itemId}
                onChange={setItemId}
                options={models.map((m) => ({ value: m.id, label: m.name }))}
                placeholder="انتخاب مدل"
              />
            </Field>
            <Field label="شماره سریال">
              <input
                className={watchInputClass}
                dir="ltr"
                value={serialNumber}
                onChange={(e) => setSerialNumber(e.target.value)}
                required
              />
            </Field>
            <Field label={`بهای تمام‌شده (${money.unitLabel})`} hint="اگر هنوز مشخص نیست، خالی بگذارید.">
              <input
                className={watchInputClass}
                dir="ltr"
                inputMode="numeric"
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
                placeholder="اختیاری"
              />
            </Field>
            <Field label="گارانتی (ماه)" hint="۰ یعنی بدون گارانتی.">
              <input
                className={watchInputClass}
                dir="ltr"
                inputMode="numeric"
                value={warrantyMonths}
                onChange={(e) => setWarrantyMonths(e.target.value)}
              />
            </Field>
            <Button
              type="submit"
              disabled={busy || models.length === 0}
              size="lg"
              className="min-h-[52px] w-full border border-amber-300 px-5 font-semibold focus-visible:ring-amber-400/30"
            >
              ثبت دستگاه
            </Button>
          </form>
        </div>
      </aside>
    </div>
  );
}

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-stone-500">{label}</dt>
      <dd className="mt-0.5 break-words font-medium text-stone-700">{children}</dd>
    </div>
  );
}

const CONDITION_GRADE_OPTIONS = [
  { value: "new", label: "نو" },
  { value: "like_new", label: "در حد نو" },
  { value: "good", label: "خوب" },
  { value: "fair", label: "متوسط" },
  { value: "poor", label: "ضعیف" },
] as const;

function UnitRow({ unit, busy, run }: { unit: SerialUnit; busy: boolean; run: Runner }) {
  const money = useMoney();
  const [panel, setPanel] = useState<"cost" | "audit" | "preowned" | null>(null);
  const toggle = (next: "cost" | "audit" | "preowned") =>
    setPanel((current) => (current === next ? null : next));

  return (
    <li className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-5">
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="min-w-0 break-words font-semibold text-stone-950">{unit.itemName}</h3>
            <span className="text-xs text-muted-foreground" dir="ltr">
              {unit.serialNumber}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[unit.status]}`}>
              {SERIAL_STATUS_LABELS[unit.status]}
            </span>
          </div>

          <dl className="mt-3 grid min-w-0 gap-x-5 gap-y-2 text-xs text-stone-600 sm:grid-cols-2 xl:grid-cols-4">
            <MetaItem label="بهای تمام‌شده">
              {unit.unitCost ? money.format(unit.unitCost) : "تعیین نشده"}
            </MetaItem>
            <MetaItem label="گارانتی">{toPersianDigits(String(unit.warrantyMonths))} ماه</MetaItem>
            {unit.soldAt ? (
              <MetaItem label="تاریخ فروش">{formatJalali(unit.soldAt, { withMonthName: true })}</MetaItem>
            ) : null}
            {unit.warrantyEnd ? (
              <MetaItem label="پایان گارانتی">
                {formatJalali(unit.warrantyEnd, { withMonthName: true })}
              </MetaItem>
            ) : null}
          </dl>
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={secondaryActionClass}
            disabled={busy || unit.status === "sold"}
            onClick={() => toggle("cost")}
          >
            ویرایش بها
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={secondaryActionClass}
            disabled={busy}
            onClick={() => toggle("audit")}
          >
            تاریخچه
          </Button>
          {unit.status === "in_stock" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={secondaryActionClass}
              disabled={busy}
              onClick={() => toggle("preowned")}
            >
              ثبت دست‌دوم
            </Button>
          ) : null}
          {unit.status === "in_stock" ? (
            // Selling happens on the invoice screen, the only place a sale
            // becomes a document (Phase 25 Wave 3). This page manages the
            // catalogue; it no longer offers a parallel way to sell one unit
            // straight to the ledger.
            <Link
              href="/dashboard/pos"
              className="inline-flex min-h-[44px] items-center rounded-md border border-amber-300 bg-amber-100 px-3 text-xs font-semibold text-amber-950 transition-colors hover:bg-amber-200"
            >
              فروش در فاکتور
            </Link>
          ) : null}
        </div>
      </div>

      {panel === "cost" ? (
        <CostPanel unit={unit} busy={busy} run={run} onDone={() => setPanel(null)} />
      ) : null}
      {panel === "audit" ? <ItemAuditPanel itemId={unit.itemId} /> : null}
      {panel === "preowned" ? (
        <PreOwnedPanel unit={unit} busy={busy} run={run} onDone={() => setPanel(null)} />
      ) : null}
    </li>
  );
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl bg-amber-50/60 p-3 sm:p-4">{children}</div>;
}

function PreOwnedPanel({
  unit,
  busy,
  run,
  onDone,
}: {
  unit: SerialUnit;
  busy: boolean;
  run: Runner;
  onDone: () => void;
}) {
  const [conditionGrade, setConditionGrade] = useState("good");
  const [boxAndPapers, setBoxAndPapers] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(() =>
      api(`/api/watch/units/${unit.id}/pre-owned`, {
        method: "POST",
        body: JSON.stringify({ conditionGrade, boxAndPapers }),
      }),
    );
    if (ok) onDone();
  }

  return (
    <PanelShell>
      <form onSubmit={save} className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Field label="درجه وضعیت">
          <SearchableSelect
            className={watchInputClass}
            value={conditionGrade}
            onChange={setConditionGrade}
            options={CONDITION_GRADE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </Field>
        <div className="flex items-end pb-1">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-stone-700">
            <input
              type="checkbox"
              className="size-4 rounded border-stone-300 text-amber-500 focus:ring-amber-400/30"
              checked={boxAndPapers}
              onChange={(e) => setBoxAndPapers(e.target.checked)}
            />
            همراه جعبه و مدارک
          </label>
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={busy} size="sm" className="min-h-[44px] border border-amber-300 px-5 font-semibold">
            ثبت دست‌دوم
          </Button>
        </div>
      </form>
    </PanelShell>
  );
}

function CostPanel({
  unit,
  busy,
  run,
  onDone,
}: {
  unit: SerialUnit;
  busy: boolean;
  run: Runner;
  onDone: () => void;
}) {
  const money = useMoney();
  const [unitCost, setUnitCost] = useState(unit.unitCost ? String(money.toInput(unit.unitCost)) : "");
  const [warrantyMonths, setWarrantyMonths] = useState(String(unit.warrantyMonths));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(() =>
      api(`/api/watch/units/${unit.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          unitCost: unitCost.trim() ? money.fromInput(Math.max(0, Math.round(Number(unitCost)))) : null,
          warrantyMonths: Number(warrantyMonths || 0),
        }),
      }),
    );
    if (ok) onDone();
  }

  return (
    <PanelShell>
      <form onSubmit={save} className="grid min-w-0 gap-3 sm:grid-cols-3">
        <Field label={`بهای تمام‌شده (${money.unitLabel})`}>
          <input
            className={watchInputClass}
            dir="ltr"
            inputMode="numeric"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
          />
        </Field>
        <Field label="گارانتی (ماه)">
          <input
            className={watchInputClass}
            dir="ltr"
            inputMode="numeric"
            value={warrantyMonths}
            onChange={(e) => setWarrantyMonths(e.target.value)}
          />
        </Field>
        <div className="sm:col-span-3">
          <Button type="submit" disabled={busy} size="sm" className="min-h-[44px] border border-amber-300 px-5 font-semibold">
            ذخیره
          </Button>
        </div>
      </form>
    </PanelShell>
  );
}
