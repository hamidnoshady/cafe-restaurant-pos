"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { expectedMaterialCost, productionUnitCost } from "@/lib/production";
import { quantityText, rialText } from "@/lib/inventory-exact";
import { api, Field, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import type { InventoryItem, Runner } from "./inventory-manager";
import { SectionCardSkeleton, cardClass } from "../page-chrome";

const productionInputClass = `${inputClass} min-h-[52px] !border-border !bg-card shadow-none placeholder:text-muted-foreground focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60 focus-visible:ring-amber-400/30 dark:focus-visible:ring-amber-400/40`;

interface FormulaInputRow {
  inventoryItemId: string;
  itemName: string;
  unit: string;
  quantity: string;
  avgCost: string;
}

interface Formula {
  id: string;
  name: string;
  outputInventoryItemId: string;
  outputItemName: string;
  outputUnit: string;
  outputQuantity: string;
  conversionCostRial: string;
  notes: string | null;
  isActive: boolean;
  inputs: FormulaInputRow[];
}

interface Run {
  id: string;
  formulaName: string;
  outputItemName: string;
  outputUnit: string;
  batches: string;
  expectedQuantity: string;
  outputQuantity: string;
  materialCostRial: string;
  conversionCostRial: string;
  totalCostRial: string;
  unitCostRial: string;
  note: string | null;
  producedAt: string;
  producedByName: string | null;
  isReversal: boolean;
  reversedByRunId: string | null;
}

/**
 * تولید — the step between raw materials and the menu.
 *
 * A formula says what one batch consumes and how much it yields; a run records
 * an actual batch and moves the stock and the ledger. The produced item is an
 * ordinary inventory item, so once a batch is recorded its cost shows up in
 * «اقلام انبار», in the serving recipe on the «دستورالعمل مصرف» tab, and in the
 * menu item's suggested price, with nothing further to configure.
 */
export function ProductionSection({
  items,
  busy,
  run,
}: {
  items: InventoryItem[];
  busy: boolean;
  run: Runner;
}) {
  const [formulas, setFormulas] = useState<Formula[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [formulaResult, runResult] = await Promise.allSettled([
      api<{ formulas: Formula[] }>("/api/inventory/production/formulas"),
      api<{ runs: Run[] }>("/api/inventory/production/runs"),
    ]);
    if (formulaResult.status === "fulfilled" && formulaResult.value.ok) {
      setFormulas(formulaResult.value.data.formulas);
    }
    if (runResult.status === "fulfilled" && runResult.value.ok) {
      setRuns(runResult.value.data.runs);
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // The shared runner reloads the inventory overview; production has its own
  // two lists, so wrap it to refresh those on the same success.
  const runAndReload: Runner = useCallback(
    async (fn) => {
      const ok = await run(fn);
      if (ok) load();
      return ok;
    },
    [run, load],
  );

  if (!loaded) {
    return (
      <div className="space-y-5">
        <SectionCardSkeleton rows={5} />
        <SectionCardSkeleton rows={4} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FormulaCard items={items} formulas={formulas} busy={busy} run={runAndReload} />
      <RunCard formulas={formulas} runs={runs} busy={busy} run={runAndReload} />
    </div>
  );
}

function FormulaCard({
  items,
  formulas,
  busy,
  run,
}: {
  items: InventoryItem[];
  formulas: Formula[];
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const [formulaId, setFormulaId] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [outputItemId, setOutputItemId] = useState("");
  const [outputQuantity, setOutputQuantity] = useState("");
  const [conversionCost, setConversionCost] = useState("");
  const [inputItemId, setInputItemId] = useState("");
  const [inputQuantity, setInputQuantity] = useState("");

  const selected = formulas.find((f) => f.id === formulaId) ?? null;
  const activeItems = items.filter((i) => i.is_active);

  // Priced from each ingredient's running average cost, so the owner can see
  // what a slice costs before ever baking one. An estimate: a real run is
  // costed by the exact FIFO/weighted-average path instead.
  const estimate = useMemo(() => {
    if (!selected) return null;
    const material = expectedMaterialCost(
      selected.inputs.map((i) => ({
        inventoryItemId: i.inventoryItemId,
        quantity: quantityText(i.quantity),
      })),
      new Map(selected.inputs.map((i) => [i.inventoryItemId, i.avgCost])),
    );
    const total = rialText((BigInt(material) + BigInt(selected.conversionCostRial)).toString());
    return {
      material: Number(material),
      total: Number(total),
      unit: productionUnitCost(total, quantityText(selected.outputQuantity)),
    };
  }, [selected]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !outputItemId || !outputQuantity.trim()) return;
    let conversionCostRial = "0";
    if (conversionCost.trim()) {
      try {
        conversionCostRial = String(money.parse(conversionCost));
      } catch {
        return;
      }
    }
    const ok = await run(() =>
      api("/api/inventory/production/formulas", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          outputInventoryItemId: outputItemId,
          outputQuantity: outputQuantity.trim(),
          conversionCostRial,
        }),
      }),
    );
    if (ok) {
      setName("");
      setOutputItemId("");
      setOutputQuantity("");
      setConversionCost("");
      setCreating(false);
    }
  }

  async function addInput(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !inputItemId || !inputQuantity.trim()) return;
    const ok = await run(() =>
      api(`/api/inventory/production/formulas/${selected.id}/inputs`, {
        method: "POST",
        body: JSON.stringify({ inventoryItemId: inputItemId, quantity: inputQuantity.trim() }),
      }),
    );
    if (ok) setInputQuantity("");
  }

  return (
    <section className={`min-w-0 ${cardClass} p-5`}>
      <h2 className="mb-1 font-semibold">فرمول‌های تولید</h2>
      <p className="mb-3 text-xs leading-5 text-muted-foreground">
        برای کالاهایی که خودتان می‌سازید: یک بار پخت چه موادی مصرف می‌کند و چند واحد محصول می‌دهد.
        محصول به‌دست‌آمده مثل هر قلم انبار دیگری موجودی و بهای تمام‌شده دارد و می‌توانید آن را در
        «دستورالعمل مصرف» به آیتم منو وصل کنید.
      </p>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <Field label="فرمول">
            <SearchableSelect
              value={formulaId}
              onChange={setFormulaId}
              options={[
                { value: "", label: "فرمول را انتخاب کنید…" },
                ...formulas.map((f) => ({
                  value: f.id,
                  label: f.isActive ? f.name : `${f.name} (غیرفعال)`,
                  searchString: [f.name, f.outputItemName].join(" "),
                })),
              ]}
            />
          </Field>
        </div>
        <div className="mb-4">
          <SecondaryButton disabled={busy} onClick={() => setCreating((v) => !v)}>
            {creating ? "انصراف" : "فرمول جدید"}
          </SecondaryButton>
        </div>
      </div>

      {creating ? (
        <form onSubmit={create} className="mb-5 grid min-w-0 gap-3 rounded-xl border border-border p-4 sm:grid-cols-2">
          <Field label="نام فرمول">
            <input
              className={productionInputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="مثلاً تولید کیک شکلاتی"
              required
            />
          </Field>
          <Field label="محصول تولیدشده (قلم انبار)">
            <SearchableSelect
              value={outputItemId}
              onChange={setOutputItemId}
              options={[
                { value: "", label: "قلم انبار را انتخاب کنید…" },
                ...activeItems.map((i) => ({
                  value: i.id,
                  label: `${i.name} (${i.unit})`,
                  searchString: [i.name, i.sku, i.unit].filter(Boolean).join(" "),
                })),
              ]}
            />
          </Field>
          <Field label="مقدار تولید در هر بار پخت" hint="به واحد پایهٔ محصول، مثلاً ۸ برش">
            <PersianNumberInput
              className={productionInputClass}
              dir="ltr"
              inputMode="decimal"
              value={outputQuantity}
              onChange={(e) => setOutputQuantity(e.target.value)}
              placeholder="مثلاً ۸"
              required
            />
          </Field>
          <Field label={`هزینهٔ تبدیل هر بار پخت (${money.unitLabel})`} hint="دستمزد و سربار؛ اختیاری">
            <PersianNumberInput
              className={productionInputClass}
              dir="ltr"
              inputMode="numeric"
              value={conversionCost}
              onChange={(e) => setConversionCost(e.target.value)}
              placeholder="اختیاری"
            />
          </Field>
          <div className="mb-4 flex items-end sm:col-span-2">
            <PrimaryButton disabled={busy}>ثبت فرمول</PrimaryButton>
          </div>
        </form>
      ) : null}

      {selected ? (
        <>
          <div className="mb-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-4 py-3 text-sm text-amber-950 dark:text-amber-200">
            <p>
              هر بار پخت: {formatQuantity(selected.outputQuantity)} {selected.outputUnit} از «
              {selected.outputItemName}»
            </p>
            {estimate ? (
              <p className="mt-1 text-xs leading-5">
                بهای تخمینی مواد: {money.format(estimate.material)} + هزینهٔ تبدیل:{" "}
                {money.format(Number(selected.conversionCostRial))} ← هر {selected.outputUnit} حدود{" "}
                {money.format(Math.round(Number(estimate.unit)))}
              </p>
            ) : null}
          </div>

          <ul className="mb-3 divide-y divide-border rounded-lg border border-border">
            {selected.inputs.map((line) => (
              <li
                key={line.inventoryItemId}
                className="flex min-w-0 flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="break-words">
                  {line.itemName} — {formatQuantity(line.quantity)} {line.unit}
                </span>
                <SecondaryButton
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`مادهٔ «${line.itemName}» از فرمول حذف شود؟`)) return;
                    void run(() =>
                      api(
                        `/api/inventory/production/formulas/${selected.id}/inputs?inventoryItemId=${line.inventoryItemId}`,
                        { method: "DELETE" },
                      ),
                    );
                  }}
                >
                  حذف
                </SecondaryButton>
              </li>
            ))}
            {selected.inputs.length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">
                هنوز ماده‌ای ثبت نشده است. تا وقتی حداقل یک ماده ثبت نشود، امکان ثبت تولید نیست.
              </li>
            ) : null}
          </ul>

          <form onSubmit={addInput} className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Field label="قلم انبار">
              <SearchableSelect
                value={inputItemId}
                onChange={setInputItemId}
                options={[
                  { value: "", label: "قلم انبار را انتخاب کنید…" },
                  ...activeItems.map((i) => ({
                    value: i.id,
                    label: `${i.name} (${i.unit})${i.is_produced ? " — ساخت داخلی" : ""}`,
                    searchString: [i.name, i.sku, i.unit].filter(Boolean).join(" "),
                  })),
                ]}
              />
            </Field>
            <Field label="مقدار مصرف در هر بار پخت">
              <PersianNumberInput
                className={productionInputClass}
                dir="ltr"
                inputMode="decimal"
                value={inputQuantity}
                onChange={(e) => setInputQuantity(e.target.value)}
                placeholder="مثلاً ۵۰۰"
                required
              />
            </Field>
            <div className="mb-4 flex items-end">
              <PrimaryButton disabled={busy}>ثبت ماده</PrimaryButton>
            </div>
          </form>
        </>
      ) : null}
    </section>
  );
}

function RunCard({
  formulas,
  runs,
  busy,
  run,
}: {
  formulas: Formula[];
  runs: Run[];
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const [formulaId, setFormulaId] = useState("");
  const [batches, setBatches] = useState("1");
  const [outputQuantity, setOutputQuantity] = useState("");
  const [conversionCost, setConversionCost] = useState("");
  const [note, setNote] = useState("");

  const selected = formulas.find((f) => f.id === formulaId) ?? null;

  // Prefill the yield and the labour from the formula the moment one is picked,
  // so the common case is one click and «ثبت» — the fields are there to be
  // corrected when the tray came out differently, not filled in every time.
  function pickFormula(id: string) {
    setFormulaId(id);
    const formula = formulas.find((f) => f.id === id);
    if (!formula) return;
    const count = Number(batches) || 1;
    setOutputQuantity(String(Number(formula.outputQuantity) * count));
    setConversionCost(String(money.toInput(Number(formula.conversionCostRial) * count)));
  }

  function changeBatches(value: string) {
    setBatches(value);
    const count = Number(value);
    if (!selected || !Number.isFinite(count) || count <= 0) return;
    setOutputQuantity(String(Number(selected.outputQuantity) * count));
    setConversionCost(String(money.toInput(Number(selected.conversionCostRial) * count)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!formulaId || !batches.trim()) return;
    let conversionCostRial: string | null = null;
    if (conversionCost.trim()) {
      try {
        conversionCostRial = String(money.parse(conversionCost));
      } catch {
        return;
      }
    }
    const ok = await run(() =>
      api("/api/inventory/production/runs", {
        method: "POST",
        body: JSON.stringify({
          formulaId,
          batches: batches.trim(),
          outputQuantity: outputQuantity.trim() || null,
          conversionCostRial,
          note: note.trim() || null,
        }),
      }),
    );
    if (ok) setNote("");
  }

  return (
    <section className={`min-w-0 ${cardClass} p-5`}>
      <h2 className="mb-1 font-semibold">ثبت تولید</h2>
      <p className="mb-3 text-xs leading-5 text-muted-foreground">
        با ثبت تولید، مواد اولیه از انبار کم و محصول با بهای واقعی (مواد + هزینهٔ تبدیل) به انبار
        اضافه می‌شود. اگر مقدار به‌دست‌آمده با فرمول فرق داشت، همان مقدار واقعی را وارد کنید؛ بهای هر
        واحد بر همان تقسیم می‌شود.
      </p>

      <form onSubmit={submit} className="mb-5 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Field label="فرمول">
          <SearchableSelect
            value={formulaId}
            onChange={pickFormula}
            options={[
              { value: "", label: "فرمول را انتخاب کنید…" },
              ...formulas
                .filter((f) => f.isActive && f.inputs.length > 0)
                .map((f) => ({
                  value: f.id,
                  label: f.name,
                  searchString: [f.name, f.outputItemName].join(" "),
                })),
            ]}
          />
        </Field>
        <Field label="تعداد بار پخت">
          <PersianNumberInput
            className={productionInputClass}
            dir="ltr"
            inputMode="decimal"
            value={batches}
            onChange={(e) => changeBatches(e.target.value)}
            required
          />
        </Field>
        <Field
          label="مقدار واقعی تولیدشده"
          hint={selected ? `به ${selected.outputUnit}` : "ابتدا فرمول را انتخاب کنید"}
        >
          <PersianNumberInput
            className={productionInputClass}
            dir="ltr"
            inputMode="decimal"
            value={outputQuantity}
            onChange={(e) => setOutputQuantity(e.target.value)}
            placeholder="مطابق فرمول"
          />
        </Field>
        <Field label={`هزینهٔ تبدیل (${money.unitLabel})`} hint="دستمزد و سربار این بار پخت">
          <PersianNumberInput
            className={productionInputClass}
            dir="ltr"
            inputMode="numeric"
            value={conversionCost}
            onChange={(e) => setConversionCost(e.target.value)}
            placeholder="اختیاری"
          />
        </Field>
        <Field label="توضیح">
          <input
            className={productionInputClass}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="اختیاری"
          />
        </Field>
        <div className="mb-4 flex items-end">
          <PrimaryButton disabled={busy || !formulaId}>ثبت تولید</PrimaryButton>
        </div>
      </form>

      <h3 className="mb-2 text-sm font-semibold">تولیدهای اخیر</h3>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {runs.map((item) => (
          <RunRow key={item.id} item={item} busy={busy} run={run} />
        ))}
        {runs.length === 0 ? (
          <li className="px-3 py-3 text-xs text-muted-foreground">هنوز تولیدی ثبت نشده است.</li>
        ) : null}
      </ul>
    </section>
  );
}

function RunRow({ item, busy, run }: { item: Run; busy: boolean; run: Runner }) {
  const money = useMoney();
  const shortfall = Number(item.expectedQuantity) - Number(item.outputQuantity);

  return (
    <li className="flex min-w-0 flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 break-words">
        <p className={item.isReversal ? "text-muted-foreground line-through" : ""}>
          {item.formulaName} — {formatQuantity(item.outputQuantity)} {item.outputUnit} «
          {item.outputItemName}»
        </p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {toPersianDigits(formatJalali(item.producedAt, { withMonthName: true }))}
          {" · "}
          مواد {money.format(Number(item.materialCostRial))} + تبدیل{" "}
          {money.format(Number(item.conversionCostRial))} ← هر {item.outputUnit}{" "}
          {money.format(Math.round(Number(item.unitCostRial)))}
          {!item.isReversal && shortfall > 0
            ? ` · ${formatQuantity(shortfall)} ${item.outputUnit} کمتر از فرمول`
            : ""}
          {item.producedByName ? ` · ${item.producedByName}` : ""}
        </p>
        {item.note ? <p className="mt-0.5 text-xs text-muted-foreground">{item.note}</p> : null}
      </div>
      {item.isReversal ? (
        <span className="shrink-0 text-xs text-muted-foreground">سند برگشت</span>
      ) : item.reversedByRunId ? (
        <span className="shrink-0 text-xs text-muted-foreground">برگشت خورده</span>
      ) : (
        <SecondaryButton
          disabled={busy}
          onClick={() => {
            if (
              !window.confirm(
                `تولید «${item.formulaName}» برگشت بخورد؟ مواد به انبار بازمی‌گردد و محصول از موجودی کم می‌شود.`,
              )
            )
              return;
            void run(() =>
              api(`/api/inventory/production/runs/${item.id}/reverse`, {
                method: "POST",
                body: JSON.stringify({}),
              }),
            );
          }}
        >
          برگشت
        </SecondaryButton>
      )}
    </li>
  );
}
