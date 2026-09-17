"use client";

import Decimal from "decimal.js";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { expectedMaterialCost, productionUnitCost } from "@/lib/production";
import { quantityText, rialText } from "@/lib/inventory-exact";
import { api, Field, inputClass } from "../ui";
import { Button } from "@/components/ui/button";
import type { InventoryItem, Runner } from "./inventory-manager";
import { SectionCardSkeleton, SectionCard } from "../page-chrome";

/**
 * Scale a per-batch value by the batch count with Decimal, not float.
 *
 * `Number("2.1") * 3` is `6.300000000000001` — sixteen decimals the API's
 * `positiveQuantityText` validator (nine-decimal cap) rejects with
 * `quantity_precision_exceeded`, which would fail the ordinary «انتخاب فرمول →
 * ثبت تولید» flow for any fractional yield or batch count. Rounding to nine
 * places here matches how the server scales the very same numbers.
 */
function scaleByBatches(perBatch: string, batches: string): string {
  try {
    const count = new Decimal(batches || "0");
    if (!count.isFinite() || count.lte(0)) return "";
    return new Decimal(perBatch || "0")
      .times(count)
      .toDecimalPlaces(9, Decimal.ROUND_HALF_UP)
      .toFixed();
  } catch {
    // A partially-typed value like "." or "-" is not yet a number; leave the
    // prefilled yield alone rather than throwing during keystrokes.
    return "";
  }
}



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
    <div className="space-y-4 sm:space-y-5">
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

  // Editing the picked formula's own header (name / yield / conversion cost).
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editOutputQuantity, setEditOutputQuantity] = useState("");
  const [editConversionCost, setEditConversionCost] = useState("");

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
    let createdId = "";
    const ok = await run(async () => {
      const result = await api<{ ok: boolean; id?: string; error?: string }>(
        "/api/inventory/production/formulas",
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            outputInventoryItemId: outputItemId,
            outputQuantity: outputQuantity.trim(),
            conversionCostRial,
          }),
        },
      );
      if (result.ok && result.data.id) createdId = result.data.id;
      return result;
    });
    if (ok) {
      setName("");
      setOutputItemId("");
      setOutputQuantity("");
      setConversionCost("");
      setCreating(false);
      // Jump straight to the new formula so its (mandatory) materials can be
      // added without hunting for it again in the picker.
      if (createdId) setFormulaId(createdId);
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
    if (ok) {
      setInputItemId("");
      setInputQuantity("");
    }
  }

  function startEditing() {
    if (!selected) return;
    setEditName(selected.name);
    setEditOutputQuantity(selected.outputQuantity);
    setEditConversionCost(String(money.toInput(Number(selected.conversionCostRial))));
    setEditing(true);
  }

  async function saveEdits(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !editName.trim() || !editOutputQuantity.trim()) return;
    let conversionCostRial = "0";
    if (editConversionCost.trim()) {
      try {
        conversionCostRial = String(money.parse(editConversionCost));
      } catch {
        return;
      }
    }
    const ok = await run(() =>
      api(`/api/inventory/production/formulas/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName.trim(),
          outputQuantity: editOutputQuantity.trim(),
          conversionCostRial,
        }),
      }),
    );
    if (ok) setEditing(false);
  }

  async function toggleActive() {
    if (!selected) return;
    await run(() =>
      api(`/api/inventory/production/formulas/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !selected.isActive }),
      }),
    );
  }

  async function removeFormula() {
    if (!selected) return;
    if (
      !window.confirm(
        `فرمول «${selected.name}» حذف شود؟ فرمولی که سابقهٔ تولید دارد به‌جای حذف، غیرفعال می‌شود.`,
      )
    )
      return;
    const ok = await run(() =>
      api(`/api/inventory/production/formulas/${selected.id}`, { method: "DELETE" }),
    );
    if (ok) {
      setFormulaId("");
      setEditing(false);
    }
  }

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">تولید</p>
          <h2 className="mt-1 font-semibold text-foreground">فرمول‌های تولید</h2>
        </div>
      }
      description="برای کالاهایی که خودتان می‌سازید: یک بار پخت چه موادی مصرف می‌کند و چند واحد محصول می‌دهد. محصول به‌دست‌آمده مثل هر قلم انبار دیگری موجودی و بهای تمام‌شده دارد."
    >

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <Field label="فرمول">
            <SearchableSelect
              value={formulaId}
              onChange={(id) => {
                setFormulaId(id);
                setEditing(false);
                setInputItemId("");
                setInputQuantity("");
              }}
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
          <Button type="button" variant="outline" disabled={busy} onClick={() => setCreating((v) => !v)}>
            {creating ? "انصراف" : "فرمول جدید"}
          </Button>
        </div>
      </div>

      {creating ? (
        <form onSubmit={create} className="mb-5 grid min-w-0 gap-3 rounded-xl border border-border p-4 sm:grid-cols-2">
          <Field label="نام فرمول">
            <input
              className={inputClass}
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
              className={inputClass}
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
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={conversionCost}
              onChange={(e) => setConversionCost(e.target.value)}
              placeholder="اختیاری"
            />
          </Field>
          <div className="mb-4 flex items-end sm:col-span-2">
            <Button type="submit" size="lg" className="w-full px-5 font-semibold" disabled={busy}>ثبت فرمول</Button>
          </div>
        </form>
      ) : null}

      {selected ? (
        <>
          <div className="mb-3 flex flex-col gap-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-4 py-3 text-sm text-amber-950 dark:text-amber-200 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="break-words">
                {!selected.isActive ? (
                  <span className="me-1 rounded-full bg-amber-200/70 dark:bg-amber-500/25 px-2 py-0.5 text-[0.7rem] font-medium">
                    غیرفعال
                  </span>
                ) : null}
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
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={startEditing}>
                {editing ? "بستن ویرایش" : "ویرایش فرمول"}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={toggleActive}>
                {selected.isActive ? "غیرفعال‌کردن" : "فعال‌کردن"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={busy}
                onClick={removeFormula}
              >
                حذف
              </Button>
            </div>
          </div>

          {editing ? (
            <form
              onSubmit={saveEdits}
              className="mb-4 grid min-w-0 gap-3 rounded-xl border border-border p-4 sm:grid-cols-2"
            >
              <Field label="نام فرمول">
                <input
                  className={inputClass}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  required
                />
              </Field>
              <Field label="مقدار تولید در هر بار پخت" hint={`به ${selected.outputUnit}`}>
                <PersianNumberInput
                  className={inputClass}
                  dir="ltr"
                  inputMode="decimal"
                  value={editOutputQuantity}
                  onChange={(e) => setEditOutputQuantity(e.target.value)}
                  required
                />
              </Field>
              <Field label={`هزینهٔ تبدیل هر بار پخت (${money.unitLabel})`} hint="دستمزد و سربار؛ اختیاری">
                <PersianNumberInput
                  className={inputClass}
                  dir="ltr"
                  inputMode="numeric"
                  value={editConversionCost}
                  onChange={(e) => setEditConversionCost(e.target.value)}
                  placeholder="اختیاری"
                />
              </Field>
              <div className="mb-4 flex items-end gap-2 sm:col-span-2">
                <Button type="submit" size="lg" className="px-5 font-semibold" disabled={busy}>
                  ذخیرهٔ تغییرات
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  disabled={busy}
                  onClick={() => setEditing(false)}
                >
                  انصراف
                </Button>
              </div>
            </form>
          ) : null}

          <ul className="mb-3 divide-y divide-border rounded-lg border border-border">
            {selected.inputs.map((line) => (
              <li
                key={line.inventoryItemId}
                className="flex min-w-0 flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="break-words">
                  {line.itemName} — {formatQuantity(line.quantity)} {line.unit}
                </span>
                <Button type="button" variant="outline"
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
                </Button>
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
                className={inputClass}
                dir="ltr"
                inputMode="decimal"
                value={inputQuantity}
                onChange={(e) => setInputQuantity(e.target.value)}
                placeholder="مثلاً ۵۰۰"
                required
              />
            </Field>
            <div className="mb-4 flex items-end">
              <Button type="submit" size="lg" className="w-full px-5 font-semibold" disabled={busy}>ثبت ماده</Button>
            </div>
          </form>
        </>
      ) : null}
    </SectionCard>
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
  function prefillFrom(formula: Formula, count: string) {
    setOutputQuantity(scaleByBatches(formula.outputQuantity, count));
    // Conversion cost is whole Rial, so round to an integer before handing it
    // to the money input; scaleByBatches returns "" for a not-yet-valid count.
    const scaledConversion = scaleByBatches(formula.conversionCostRial, count);
    if (scaledConversion) {
      setConversionCost(String(money.toInput(Math.round(Number(scaledConversion)))));
    }
  }

  function pickFormula(id: string) {
    setFormulaId(id);
    const formula = formulas.find((f) => f.id === id);
    if (!formula) return;
    prefillFrom(formula, batches.trim() || "1");
  }

  function changeBatches(value: string) {
    setBatches(value);
    const count = Number(value);
    if (!selected || !Number.isFinite(count) || count <= 0) return;
    prefillFrom(selected, value);
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
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">عملیات تولید</p>
          <h2 className="mt-1 font-semibold text-foreground">ثبت تولید</h2>
        </div>
      }
      description="با ثبت تولید، مواد اولیه از انبار کم و محصول با بهای واقعی (مواد + هزینهٔ تبدیل) به انبار اضافه می‌شود. اگر مقدار به‌دست‌آمده با فرمول فرق داشت، همان مقدار واقعی را وارد کنید."
    >

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
            className={inputClass}
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
            className={inputClass}
            dir="ltr"
            inputMode="decimal"
            value={outputQuantity}
            onChange={(e) => setOutputQuantity(e.target.value)}
            placeholder="مطابق فرمول"
          />
        </Field>
        <Field label={`هزینهٔ تبدیل (${money.unitLabel})`} hint="دستمزد و سربار این بار پخت">
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            value={conversionCost}
            onChange={(e) => setConversionCost(e.target.value)}
            placeholder="اختیاری"
          />
        </Field>
        <Field label="توضیح">
          <input
            className={inputClass}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="اختیاری"
          />
        </Field>
        <div className="mb-4 flex items-end">
          <Button type="submit" size="lg" className="w-full px-5 font-semibold" disabled={busy || !formulaId}>ثبت تولید</Button>
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
    </SectionCard>
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
        <Button type="button" variant="outline"
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
        </Button>
      )}
    </li>
  );
}
