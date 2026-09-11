"use client";

/**
 * Phase 42b — «ثبت رسید انبار/حواله»: one screen for the two RETAIL warehouse
 * documents (items/item_stock/item_batches).
 *
 * A رسید (receipt) puts stock in without a purchase — lines carry a
 * whole-Rial unit cost (required) plus, for a batch-tracked item, the lot
 * number and a Jalali expiry; an existing lot is topped up and re-averaged, a
 * new one is created. A حواله (issue) puts stock out without a sale or a
 * supplier return — a batch-tracked line names the lot it relieves (selected
 * from /api/stock/batches, cost auto-filled from that lot), a plain line is
 * relieved at its running cost.
 *
 * The document is posted on create: the success summary reports the total and
 * the GL entry (Dr/Cr account codes) the posting engine wrote.
 */
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { LoadingSkeleton, SectionCard } from "../page-chrome";
import { JalaliDatePicker } from "../jalali-date-picker";
import { type Warehouse, warehouseErrorMessage } from "./warehouses-section";

type DocKind = "receipt" | "issue";

interface StockItemOption {
  id: string;
  name: string;
  sku: string | null;
  tracking: string;
  quantity: string;
  unitCost: number | null;
}

interface StockLevelsResponse {
  items: StockItemOption[];
}

interface BatchOption {
  id: string;
  batchNumber: string;
  expiryDate: string | null;
  quantity: string;
  unitCost: number | null;
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
  itemId: string;
  quantity: string;
  /** Receipt: the typed cost (input units). Issue: unused — the lot/stock cost is authoritative. */
  unitCost: string;
  /** Receipt: the lot number to upsert. Issue: the lot number to relieve (batch items). */
  lot: string;
  expiryDate: string;
}

function newLine(): DocLine {
  return { key: crypto.randomUUID(), itemId: "", quantity: "", unitCost: "", lot: "", expiryDate: "" };
}

const DOC_ERRORS: Record<string, string> = {
  missing_fields: "انبار را انتخاب کنید.",
  no_items: "حداقل یک قلم لازم است.",
  invalid_line: "یکی از اقلام انتخاب نشده یا یک قلم دو بار آمده است.",
  invalid_quantity: "تعداد هر قلم باید عددی بزرگ‌تر از صفر باشد.",
  missing_cost: "بهای تمام‌شده هر قلم رسید را وارد کنید.",
  invalid_cost: "بهای تمام‌شده باید عدد صحیح به ریال باشد.",
  ledger_account_missing: "حساب مورد نیاز در دفتر حساب‌ها موجود نیست.",
};

interface PostedSummary {
  kind: DocKind;
  totalValue: string;
  entryId: string | null;
  debitCode: string;
  creditCode: string;
}

export function DocumentFormSection({ onCreated }: { onCreated?: () => void }) {
  const money = useMoney();
  const [kind, setKind] = useState<DocKind>("receipt");
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);
  const [locationId, setLocationId] = useState("");
  const [items, setItems] = useState<StockItemOption[] | null>(null);
  const [recipient, setRecipient] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DocLine[]>([newLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [posted, setPosted] = useState<PostedSummary | null>(null);
  // Lots of the issue line being edited: fetched per (item, branch) on demand.
  const [lotOptions, setLotOptions] = useState<Record<string, BatchOption[]>>({});

  const loadWarehouses = useCallback(() => {
    api<{ warehouses: Warehouse[] }>("/api/stock/warehouses").then(({ ok, data }) => {
      if (ok) {
        setWarehouses(data.warehouses);
        const active = data.warehouses.find((w) => w.is_active);
        if (active) setLocationId((current) => current || active.id);
      }
    });
  }, []);
  useEffect(loadWarehouses, [loadWarehouses]);

  // Item options come from the selected warehouse's own stock levels: retail
  // items are per-branch, so switching warehouse re-points the picker. Only
  // fungible items (none/batch) can travel on a warehouse document — serial
  // and weight items have their own intake paths and are refused server-side.
  useEffect(() => {
    if (!locationId) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setItems(null);
    api<StockLevelsResponse>(`/api/stock/stock-levels?locationId=${encodeURIComponent(locationId)}`).then(
      ({ ok, data }) => {
        if (!cancelled) setItems(ok ? data.items.filter((i) => i.tracking === "none" || i.tracking === "batch") : []);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  const itemOptions = useMemo(
    () =>
      items === null
        ? []
        : [
            { value: "", label: "کالا را انتخاب کنید…" },
            ...items.map((i) => ({
              value: i.id,
              label: i.sku ? `${i.name} (${i.sku})` : i.name,
              searchString: [i.name, i.sku ?? ""].join(" "),
            })),
          ],
    [items],
  );

  const itemById = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);

  // The issue form's lot select: fetch the item's lots at this branch once
  // per item, when an issue line names it.
  useEffect(() => {
    if (kind !== "issue" || !locationId) return;
    const missing = lines
      .map((l) => l.itemId)
      .filter((id) => id && itemById.get(id)?.tracking === "batch" && !lotOptions[id]);
    if (missing.length === 0) return;
    let cancelled = false;
    for (const itemId of missing) {
      api<{ batches: BatchOption[] }>(
        `/api/stock/batches?item=${encodeURIComponent(itemId)}&branch=${encodeURIComponent(locationId)}`,
      ).then(({ ok, data }) => {
        if (!cancelled && ok) setLotOptions((current) => ({ ...current, [itemId]: data.batches }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [kind, lines, locationId, itemById, lotOptions]);

  /** The cost an issue line will relieve at: the named lot's own, or the item's running cost. */
  function issueUnitCost(line: DocLine): number | null {
    const item = itemById.get(line.itemId);
    if (!item) return null;
    if (item.tracking === "batch") {
      const lot = (lotOptions[line.itemId] ?? []).find((b) => b.batchNumber === line.lot);
      return lot?.unitCost ?? null;
    }
    return item.unitCost;
  }

  /** A line's «≈» value: qty × unit cost (receipt: typed; issue: the relieved cost). */
  function lineValueRial(line: DocLine): number | null {
    const qty = Number(line.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return null;
    if (kind === "receipt") {
      const cost = Number(line.unitCost);
      if (!Number.isFinite(cost) || cost < 0) return null;
      return qty * money.fromInput(Math.max(0, Math.round(cost)));
    }
    const cost = issueUnitCost(line);
    return cost == null ? null : qty * cost;
  }

  const totalRial = useMemo(() => {
    let total = 0;
    for (const line of lines) {
      const value = lineValueRial(line);
      if (value != null) total += value;
    }
    return total;
    // lineValueRial closes over the fetched lots; lotOptions covers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, kind, money, lotOptions, itemById]);

  function updateLine(key: string, patch: Partial<DocLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }
  function removeLine(key: string) {
    setLines((current) => (current.length > 1 ? current.filter((line) => line.key !== key) : current));
  }

  function switchKind(next: DocKind) {
    if (next === kind) return;
    setKind(next);
    setLines([newLine()]);
    setPosted(null);
    setError("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !locationId) return;
    setPosted(null);
    const payload = {
      kind,
      locationId,
      recipient: kind === "issue" ? recipient : null,
      documentNumber: documentNumber || null,
      note: note || null,
      lines: lines.map((line) => ({
        itemId: line.itemId,
        quantity: line.quantity,
        unitCost:
          kind === "receipt" ? money.fromInput(Math.max(0, Math.round(Number(line.unitCost || "0")))) : undefined,
        lot: line.lot || null,
        expiryDate: kind === "receipt" && line.expiryDate ? line.expiryDate : null,
      })),
    };
    setBusy(true);
    setError("");
    const { ok, data } = await api<{
      error?: string;
      message?: string;
      totalValue?: string;
      entryId?: string | null;
      debitCode?: string;
      creditCode?: string;
    }>("/api/stock/warehouse-documents", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (!ok) {
      const code = (data as { error?: string }).error;
      setError(
        DOC_ERRORS[code ?? ""] ??
          (data.message ??
            warehouseErrorMessage(code) ??
            "ثبت سند ناموفق بود."),
      );
      return;
    }
    setLines([newLine()]);
    setRecipient("");
    setDocumentNumber("");
    setNote("");
    setPosted({
      kind,
      totalValue: data.totalValue ?? "0",
      entryId: data.entryId ?? null,
      debitCode: data.debitCode ?? "",
      creditCode: data.creditCode ?? "",
    });
    onCreated?.();
  }

  const lineGridClass =
    kind === "receipt"
      ? "grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(80px,0.7fr)_minmax(110px,0.9fr)_minmax(120px,1fr)_minmax(130px,1fr)_minmax(120px,0.9fr)_40px] xl:items-center"
      : "grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(80px,0.7fr)_minmax(110px,0.9fr)_minmax(120px,1fr)_minmax(130px,1fr)_40px] xl:items-center";
  const headerGridClass =
    kind === "receipt"
      ? "hidden text-xs font-medium text-stone-500 dark:text-stone-400 xl:grid xl:grid-cols-[minmax(0,2fr)_minmax(80px,0.7fr)_minmax(110px,0.9fr)_minmax(120px,1fr)_minmax(130px,1fr)_minmax(120px,0.9fr)_40px] xl:gap-2"
      : "hidden text-xs font-medium text-stone-500 dark:text-stone-400 xl:grid xl:grid-cols-[minmax(0,2fr)_minmax(80px,0.7fr)_minmax(110px,0.9fr)_minmax(120px,1fr)_minmax(130px,1fr)_40px] xl:gap-2";

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سند انبار</p>
          <h2 className="mt-1 font-semibold text-foreground">ثبت رسید انبار/حواله</h2>
        </div>
      }
      description="رسید انبار کالا را (بدون خرید) وارد انبار می‌کند و حواله انبار آن را (بدون فروش یا برگشت) خارج می‌کند؛ هر دو بلافاصله در موجودی و حسابداری ثبت می‌شوند."
    >
      <ErrorBox>{error}</ErrorBox>
      {posted ? (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
          <p className="font-semibold">
            {posted.kind === "receipt" ? "رسید انبار ثبت شد." : "حواله انبار ثبت شد."} جمع:{" "}
            {money.formatText(posted.totalValue)}
          </p>
          <p className="mt-1 text-xs">
            سند حسابداری: بدهکار {toPersianDigits(posted.debitCode)} / بستانکار{" "}
            {toPersianDigits(posted.creditCode)}
            {posted.entryId ? " — در دفتر روزنامه ثبت شد." : " — (سند بدون ارزش مالی بود)"}
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
              onChange={setLocationId}
              options={[
                { value: "", label: "انبار را انتخاب کنید…" },
                ...(warehouses ?? []).map((w) => ({ value: w.id, label: w.is_active ? w.name : `${w.name} (غیرفعال)` })),
              ]}
            />
          </Field>
          {kind === "issue" ? (
            <Field label="گیرنده/مقصد (اختیاری)">
              <input className={inputClass} value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="مثلاً: شعبه مرکزی" />
            </Field>
          ) : null}
          <Field label="شماره سند (اختیاری)">
            <input className={inputClass} value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} placeholder="شماره حواله کاغذی یا فاکتور" />
          </Field>
          <Field label="یادداشت (اختیاری)">
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>

        <div className="min-w-0 space-y-2">
          <div className={headerGridClass}>
            <span>کالا</span>
            <span>تعداد</span>
            <span>{kind === "receipt" ? `بهای هر واحد (${money.unitLabel})` : "بهای هر واحد"}</span>
            <span>بچ/لات</span>
            <span>{kind === "receipt" ? "انقضا (شمسی)" : "≈ ارزش"}</span>
            {kind === "receipt" ? <span>≈ ارزش</span> : null}
            <span className="sr-only">حذف</span>
          </div>
          {items === null ? (
            <div className="min-w-0 space-y-2">
              <LoadingSkeleton rows={2} label="در حال بارگذاری اقلام انبار" />
            </div>
          ) : (
            lines.map((line) => {
              const item = itemById.get(line.itemId);
              const isBatch = item?.tracking === "batch";
              const resolvedCost = kind === "issue" ? issueUnitCost(line) : null;
              const value = lineValueRial(line);
              return (
                <div key={line.key} className={lineGridClass}>
                  <SearchableSelect value={line.itemId} onChange={(v) => updateLine(line.key, { itemId: v })} options={itemOptions} />
                  <PersianNumberInput
                    className={inputClass}
                    dir="ltr"
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                    placeholder="۰"
                    aria-label="تعداد"
                  />
                  {kind === "receipt" ? (
                    <PersianNumberInput
                      className={inputClass}
                      dir="ltr"
                      inputMode="numeric"
                      value={line.unitCost}
                      onChange={(e) => updateLine(line.key, { unitCost: e.target.value })}
                      placeholder="۰"
                      aria-label="بهای هر واحد"
                    />
                  ) : (
                    <span className="truncate text-xs tabular-nums text-muted-foreground" title="بهای relieved از خود بچ/موجودی">
                      {resolvedCost == null ? "در لحظه ثبت" : money.format(resolvedCost)}
                    </span>
                  )}
                  {kind === "receipt" ? (
                    <input
                      className={inputClass}
                      value={line.lot}
                      onChange={(e) => updateLine(line.key, { lot: e.target.value })}
                      placeholder={isBatch ? "شماره بچ (اختیاری)" : "—"}
                      disabled={!isBatch}
                      aria-label="شماره بچ"
                    />
                  ) : isBatch ? (
                    <SearchableSelect
                      value={line.lot}
                      onChange={(v) => updateLine(line.key, { lot: v })}
                      options={[
                        { value: "", label: "بچ را انتخاب کنید…" },
                        ...(lotOptions[line.itemId] ?? []).map((b) => ({
                          value: b.batchNumber,
                          label: `${b.batchNumber} · ${formatQuantity(b.quantity)}`,
                          searchString: b.batchNumber,
                        })),
                      ]}
                    />
                  ) : (
                    <span className="truncate text-xs text-muted-foreground">—</span>
                  )}
                  {kind === "receipt" ? (
                    <JalaliDatePicker
                      className={inputClass}
                      value={line.expiryDate}
                      onChange={(iso) => updateLine(line.key, { expiryDate: iso })}
                      disabled={!isBatch}
                    />
                  ) : null}
                  <span className="truncate text-xs font-medium tabular-nums text-foreground">
                    {value == null ? "≈ —" : `≈ ${money.format(value)}`}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => removeLine(line.key)}
                    disabled={lines.length === 1}
                    aria-label="حذف این قلم"
                    title="حذف این قلم"
                  >
                    <Trash2Icon aria-hidden="true" className="size-4" />
                  </Button>
                </div>
              );
            })
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((current) => [...current, newLine()])}>
              <PlusIcon aria-hidden="true" className="size-4" />
              افزودن قلم
            </Button>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              ≈ جمع: {money.format(totalRial)}
            </span>
          </div>
        </div>

        <div className="border-t border-border/80 pt-4">
          <Button type="submit" disabled={busy || !locationId} size="lg" className="w-full px-5 font-semibold">
            {busy ? "در حال ثبت…" : kind === "receipt" ? "ثبت رسید انبار" : "ثبت حواله انبار"}
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}
