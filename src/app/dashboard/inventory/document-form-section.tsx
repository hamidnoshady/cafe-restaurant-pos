"use client";

/**
 * Phase 42 — «ثبت رسید انبار/حواله»: one screen for the two warehouse
 * documents.
 *
 * A رسید (receipt) puts stock in without a purchase order — lines carry a
 * whole-Rial unit cost, which is authoritative for both the FIFO lot and the
 * ledger entry (Debit inventory / Credit other income). A حواله (issue) puts
 * stock out without a sale or waste entry — lines are valued by the
 * exact-costing path at posting time (Debit other expense / Credit inventory).
 *
 * The document is posted on create, like waste and counts: immutable after,
 * and a mistake is corrected by the opposite document.
 */
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { LoadingSkeleton, SectionCard } from "../page-chrome";
import { type Warehouse, warehouseErrorMessage } from "./warehouses-section";

type DocKind = "receipt" | "issue";

interface StockItemOption {
  id: string;
  item_name: string;
  unit: string;
}

interface StockLevelsResponse {
  items: StockItemOption[];
}

const KIND_LABELS: Record<DocKind, string> = {
  receipt: "رسید انبار (ورود کالا)",
  issue: "حواله انبار (خروج کالا)",
};

const kindChipClass = (active: boolean) =>
  `min-h-[44px] rounded-xl border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-amber-400/40 ${
    active
      ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-950 dark:text-amber-200"
      : "border-border bg-card text-stone-700 dark:text-stone-300 hover:border-amber-300 dark:hover:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-500/10 hover:text-stone-950 dark:hover:text-stone-100"
  }`;

interface DocLine {
  key: string;
  inventoryItemId: string;
  quantity: string;
  unitCost: string;
}

function newLine(): DocLine {
  return { key: crypto.randomUUID(), inventoryItemId: "", quantity: "", unitCost: "" };
}

const DOC_ERRORS: Record<string, string> = {
  missing_fields: "انبار را انتخاب کنید.",
  no_items: "حداقل یک قلم لازم است.",
  invalid_line: "یکی از سندها کامل نیست؛ قلم را انتخاب کنید و مقدار معتبر وارد کنید.",
  invalid_quantity: "مقدار هر قلم باید بزرگ‌تر از صفر باشد.",
  quantity_precision_exceeded: "مقدار حداکثر می‌تواند ۹ رقم اعشار داشته باشد.",
  invalid_rial: "قیمت واحد باید یک عدد صحیح معتبر باشد.",
  rial_out_of_range: "قیمت واحد بسیار بزرگ است؛ عدد را بررسی کنید.",
  receipt_value_required: "رسید بدون ارزش ثبت نمی‌شود؛ برای هر قلم قیمت واحد بزرگ‌تر از صفر وارد کنید.",
  location_not_found: "انبار انتخاب‌شده پیدا نشد.",
  location_inactive: "این انبار غیرفعال است؛ انبار دیگری را انتخاب کنید.",
  supplier_not_found: "تأمین‌کننده انتخاب‌شده در این انبار نیست.",
  item_not_found: "یکی از اقلام به این انبار تعلق ندارد یا غیرفعال است.",
  periodic_system_unsupported:
    "در سیستم انبارداری ادواری، رسید و حواله انبار ثبت نمی‌شود؛ ورود و خروج کالا در سند بستن دوره ثبت می‌شود.",
  ledger_account_missing: "حساب مورد نیاز در دفتر حساب‌ها موجود نیست؛ ابتدا کدینگ حساب‌ها را کامل کنید.",
  inventory_exact_cutover_required:
    "بهای تمام‌شدهٔ این قلم هنوز مقداردهی اولیه نشده است؛ ابتدا انتقال بهای تمام‌شده را انجام دهید.",
};

/** The document's own posted summary, shown after a successful ثبت. */
interface PostedSummary {
  kind: DocKind;
  totalValue: string;
}

export function DocumentFormSection({ onCreated }: { onCreated: () => void }) {
  const money = useMoney();
  const [kind, setKind] = useState<DocKind>("receipt");
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);
  const [locationId, setLocationId] = useState("");
  const [items, setItems] = useState<StockItemOption[] | null>(null);
  const [supplierId, setSupplierId] = useState("");
  const [recipient, setRecipient] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DocLine[]>([newLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [posted, setPosted] = useState<PostedSummary | null>(null);

  const loadWarehouses = useCallback(() => {
    api<{ warehouses: Warehouse[] }>("/api/inventory/warehouses").then(({ ok, data }) => {
      if (ok) {
        setWarehouses(data.warehouses);
        const active = data.warehouses.find((w) => w.is_active);
        if (active) setLocationId((current) => current || active.id);
      }
    });
  }, []);
  useEffect(loadWarehouses, [loadWarehouses]);

  const selectedWarehouse = useMemo(
    () => warehouses?.find((w) => w.id === locationId) ?? null,
    [warehouses, locationId],
  );

  // Item options come from the selected warehouse's own stock levels: items
  // are per-branch, so switching warehouse re-points the picker.
  useEffect(() => {
    if (!locationId) {
      setItems([]);
      return;
    }
    let cancelled = false;
    // Back to the skeleton while the new warehouse's items load. Without this
    // the picker kept offering the PREVIOUS warehouse's items — selectable,
    // and then refused server-side with «قلم به این انبار تعلق ندارد».
    setItems(null);
    api<StockLevelsResponse>(`/api/inventory/stock-levels?locationId=${encodeURIComponent(locationId)}`).then(
      ({ ok, data }) => {
        if (!cancelled) setItems(ok ? data.items : []);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  /**
   * Switching warehouse invalidates every line: the items belong to the branch
   * that was selected when they were picked. Clear the picked items (keeping
   * typed quantities/costs, which are still meaningful) and drop the supplier,
   * which is a per-branch list too.
   */
  function switchWarehouse(next: string) {
    if (next === locationId) return;
    setLocationId(next);
    setSupplierId("");
    setPosted(null);
    setError("");
    setLines((current) => current.map((line) => ({ ...line, inventoryItemId: "" })));
  }

  /** Receipt ⇄ حواله swap the meaning of every column, so the lines restart. */
  function switchKind(next: DocKind) {
    if (next === kind) return;
    setKind(next);
    setLines([newLine()]);
    setSupplierId("");
    setRecipient("");
    setPosted(null);
    setError("");
  }

  const supplierOptions = useMemo(() => selectedWarehouse?.suppliers ?? [], [selectedWarehouse]);

  const itemOptions = useMemo(
    () =>
      items === null
        ? []
        : [
            { value: "", label: "قلم انبار را انتخاب کنید…" },
            ...items.map((i) => ({
              value: i.id,
              label: `${i.item_name} (${i.unit})`,
              searchString: [i.item_name, i.unit].join(" "),
            })),
          ],
    [items],
  );

  /**
   * A line's unit cost as integer Rial text, or null when the field is empty
   * or not a usable number. `money.parseText` is the single conversion from
   * the business's display unit (تومان/ریال) to the Rial the API stores; it
   * throws on anything that isn't a whole number, so it is called here — once
   * — rather than in the submit handler, where an unguarded throw would have
   * left the form stuck with `busy` still true and no message.
   */
  const lineUnitCostRial = useCallback(
    (line: DocLine): string | null => {
      if (!line.unitCost.trim()) return null;
      try {
        return money.parseText(line.unitCost);
      } catch {
        return null;
      }
    },
    [money],
  );

  // Inputs are in the business display unit, while all totals and API payloads
  // are integer Rial. Keep this conversion at the UI boundary — and do the sum
  // in BigInt, because a float total drifts on large Rial amounts.
  const receiptTotal = useMemo(() => {
    if (kind !== "receipt") return null;
    let total = 0n;
    for (const line of lines) {
      const cost = lineUnitCostRial(line);
      if (cost === null) continue;
      // Quantities are decimal; multiply in Rial and round half-up per line,
      // the same rule `lineValue` applies server-side.
      const qty = Number(line.quantity);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      total += BigInt(Math.round(Number(cost) * qty));
    }
    return total.toString();
  }, [kind, lines, lineUnitCostRial]);

  /**
   * Why the submit button is disabled, or "" when the document is postable.
   * The server validates all of this too; saying it here means a person is
   * told what is missing instead of watching a request fail.
   */
  const blockingReason = useMemo(() => {
    if (!locationId) return "انبار را انتخاب کنید.";
    const filled = lines.filter((line) => line.inventoryItemId || line.quantity.trim() || line.unitCost.trim());
    if (filled.length === 0) return "حداقل یک قلم با مقدار وارد کنید.";
    const seen = new Set<string>();
    for (const line of filled) {
      if (!line.inventoryItemId) return "برای هر قلم، کالای انبار را انتخاب کنید.";
      if (seen.has(line.inventoryItemId)) return "هر قلم فقط یک بار می‌تواند در سند بیاید.";
      seen.add(line.inventoryItemId);
      const qty = Number(line.quantity);
      if (!line.quantity.trim() || !Number.isFinite(qty) || qty <= 0) {
        return "مقدار هر قلم باید بزرگ‌تر از صفر باشد.";
      }
      if (kind === "receipt") {
        const cost = lineUnitCostRial(line);
        if (cost === null) return "برای هر قلم رسید، قیمت واحد را وارد کنید.";
        if (BigInt(cost) <= 0n) return "قیمت واحد هر قلم رسید باید بزرگ‌تر از صفر باشد.";
      }
    }
    return "";
  }, [locationId, lines, kind, lineUnitCostRial]);

  function updateLine(key: string, patch: Partial<DocLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
    setPosted(null);
  }
  function removeLine(key: string) {
    setLines((current) => (current.length > 1 ? current.filter((line) => line.key !== key) : current));
    setPosted(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || blockingReason) {
      // A keyboard submit can still arrive while the button is disabled.
      if (blockingReason) setError(blockingReason);
      return;
    }
    setPosted(null);
    // Blank trailing lines are scaffolding, not content: drop them rather than
    // letting the server reject the whole document over an empty row.
    const filled = lines.filter((line) => line.inventoryItemId || line.quantity.trim() || line.unitCost.trim());
    const payload = {
      kind,
      locationId,
      supplierId: kind === "receipt" && supplierId ? supplierId : null,
      recipient: kind === "issue" ? recipient.trim() || null : null,
      documentNumber: documentNumber.trim() || null,
      note: note.trim() || null,
      lines: filled.map((line) => ({
        inventoryItemId: line.inventoryItemId,
        quantity: line.quantity,
        unitCost: kind === "receipt" ? (lineUnitCostRial(line) ?? "0") : "0",
      })),
    };
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; totalValue?: string }>(
      "/api/inventory/warehouse-documents",
      { method: "POST", body: JSON.stringify(payload) },
    );
    setBusy(false);
    if (!ok) {
      const code = (data as { error?: string }).error;
      setError(DOC_ERRORS[code ?? ""] ?? warehouseErrorMessage(code));
      return;
    }
    setLines([newLine()]);
    setSupplierId("");
    setRecipient("");
    setDocumentNumber("");
    setNote("");
    setPosted({ kind, totalValue: data.totalValue ?? "0" });
    onCreated();
  }

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سند انبار</p>
          <h2 className="mt-1 font-semibold text-foreground">ثبت رسید انبار/حواله</h2>
        </div>
      }
      description="رسید انبار کالا را وارد انبار می‌کند و حواله انبار آن را خارج می‌کند؛ هر دو بلافاصله در موجودی و حسابداری ثبت می‌شوند."
    >
      <ErrorBox>{error}</ErrorBox>
      {posted ? (
        <div
          role="status"
          className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
        >
          <p className="font-semibold">
            {posted.kind === "receipt" ? "رسید انبار ثبت شد." : "حواله انبار ثبت شد."} جمع:{" "}
            {money.formatText(posted.totalValue)}
          </p>
          <p className="mt-1 text-xs">
            سند در موجودی و دفتر روزنامه ثبت شد و قابل ویرایش نیست؛ برای اصلاح، سند معکوس ثبت کنید.
          </p>
        </div>
      ) : null}
      <form onSubmit={submit} className="min-w-0 space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="نوع سند">
          <button type="button" className={kindChipClass(kind === "receipt")} aria-pressed={kind === "receipt"} onClick={() => switchKind("receipt")}>
            {KIND_LABELS.receipt}
          </button>
          <button type="button" className={kindChipClass(kind === "issue")} aria-pressed={kind === "issue"} onClick={() => switchKind("issue")}>
            {KIND_LABELS.issue}
          </button>
        </div>

        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="انبار">
            <SearchableSelect
              value={locationId}
              onChange={switchWarehouse}
              options={[
                { value: "", label: "انبار را انتخاب کنید…" },
                ...(warehouses ?? []).map((w) => ({ value: w.id, label: w.is_active ? w.name : `${w.name} (غیرفعال)` })),
              ]}
            />
          </Field>
          {kind === "receipt" ? (
            <Field label="تأمین‌کننده (اختیاری)">
              <SearchableSelect
                value={supplierId}
                onChange={setSupplierId}
                options={[
                  { value: "", label: "بدون تأمین‌کننده" },
                  ...supplierOptions.map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
            </Field>
          ) : (
            <Field label="گیرنده/مقصد (اختیاری)">
              <input className={inputClass} value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="مثلاً: شعبه مرکزی" />
            </Field>
          )}
          <Field label="شماره سند (اختیاری)">
            <input className={inputClass} value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} placeholder="شماره فاکتور یا حواله" />
          </Field>
          <Field label="یادداشت (اختیاری)">
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>

        {/*
          The line editor. One shared four-column grid from `md` up (with a
          header row naming the columns); below that each line becomes its own
          bordered mini-card with per-field labels, because four columns never
          fit a phone — the item combobox was the thing that got crushed.
        */}
        <div className="min-w-0 space-y-2">
          <div className="hidden md:grid md:grid-cols-[minmax(0,2fr)_minmax(110px,1fr)_minmax(130px,1fr)_2.75rem] md:items-center md:gap-2 text-xs font-medium text-stone-500 dark:text-stone-400">
            <span>قلم انبار</span>
            <span>مقدار</span>
            {kind === "receipt" ? <span>قیمت واحد ({money.unitLabel})</span> : <span>ارزش (محاسبه‌شده)</span>}
            <span className="sr-only">حذف</span>
          </div>
          {items === null ? (
            <div className="min-w-0 space-y-2">
              <LoadingSkeleton rows={2} label="در حال بارگذاری اقلام انبار" />
            </div>
          ) : (
            lines.map((line) => (
              <div
                key={line.key}
                className="grid min-w-0 grid-cols-1 gap-2 rounded-xl border border-border/80 p-3 md:grid-cols-[minmax(0,2fr)_minmax(110px,1fr)_minmax(130px,1fr)_2.75rem] md:items-center md:rounded-none md:border-0 md:p-0"
              >
                <label className="grid min-w-0 gap-1 text-xs font-medium text-stone-500 dark:text-stone-400">
                  <span className="md:sr-only">قلم انبار</span>
                  <SearchableSelect value={line.inventoryItemId} onChange={(v) => updateLine(line.key, { inventoryItemId: v })} options={itemOptions} ariaLabel="قلم انبار" />
                </label>
                <label className="grid min-w-0 gap-1 text-xs font-medium text-stone-500 dark:text-stone-400">
                  <span className="md:sr-only">مقدار</span>
                  <PersianNumberInput
                    className={inputClass}
                    dir="ltr"
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                    placeholder="۰"
                    aria-label="مقدار قلم"
                  />
                </label>
                {kind === "receipt" ? (
                  <label className="grid min-w-0 gap-1 text-xs font-medium text-stone-500 dark:text-stone-400">
                    <span className="md:sr-only">قیمت واحد ({money.unitLabel})</span>
                    <PersianNumberInput
                      className={inputClass}
                      dir="ltr"
                      inputMode="numeric"
                      value={line.unitCost}
                      onChange={(e) => updateLine(line.key, { unitCost: e.target.value })}
                      placeholder="۰"
                      aria-label={`قیمت واحد به ${money.unitLabel}`}
                    />
                  </label>
                ) : (
                  <span className="truncate text-xs tabular-nums text-muted-foreground">
                    <span className="md:hidden">ارزش: </span>در لحظه ثبت
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-center text-destructive hover:bg-destructive/10 hover:text-destructive md:w-auto"
                  onClick={() => removeLine(line.key)}
                  disabled={lines.length === 1}
                  aria-label="حذف این قلم"
                  title="حذف این قلم"
                >
                  <Trash2Icon aria-hidden="true" className="size-4" />
                  <span className="md:sr-only">حذف این قلم</span>
                </Button>
              </div>
            ))
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((current) => [...current, newLine()])}>
              <PlusIcon aria-hidden="true" className="size-4" />
              افزودن قلم
            </Button>
            {kind === "receipt" && receiptTotal !== null ? (
              <span className="text-sm font-semibold tabular-nums text-foreground">
                جمع: {money.formatText(receiptTotal)}
              </span>
            ) : null}
          </div>
        </div>

        <div className="space-y-2 border-t border-border/80 pt-4">
          {blockingReason ? (
            <p id="warehouse-document-blocked" className="text-xs text-muted-foreground">
              {blockingReason}
            </p>
          ) : null}
          <Button
            type="submit"
            disabled={busy || blockingReason !== ""}
            aria-describedby={blockingReason ? "warehouse-document-blocked" : undefined}
            size="lg"
            className="w-full px-5 font-semibold"
          >
            {busy ? "در حال ثبت…" : kind === "receipt" ? "ثبت رسید انبار" : "ثبت حواله انبار"}
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}
