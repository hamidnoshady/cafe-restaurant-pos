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
  invalid_rial: "قیمت واحد باید عدد صحیح به ریال باشد.",
  location_not_found: "انبار انتخاب‌شده پیدا نشد.",
  location_inactive: "این انبار غیرفعال است؛ انبار دیگری را انتخاب کنید.",
  supplier_not_found: "تأمین‌کننده انتخاب‌شده در این انبار نیست.",
  item_not_found: "یکی از اقلام به این انبار تعلق ندارد یا غیرفعال است.",
};

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
    api<StockLevelsResponse>(`/api/inventory/stock-levels?locationId=${encodeURIComponent(locationId)}`).then(
      ({ ok, data }) => {
        if (!cancelled) setItems(ok ? data.items : []);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [locationId]);

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

  const receiptTotal = useMemo(() => {
    if (kind !== "receipt") return null;
    let total = 0;
    for (const line of lines) {
      const qty = Number(line.quantity);
      const cost = Number(line.unitCost);
      if (Number.isFinite(qty) && Number.isFinite(cost)) total += qty * cost;
    }
    return total;
  }, [kind, lines]);

  function updateLine(key: string, patch: Partial<DocLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }
  function removeLine(key: string) {
    setLines((current) => (current.length > 1 ? current.filter((line) => line.key !== key) : current));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !locationId) return;
    const payload = {
      kind,
      locationId,
      supplierId: kind === "receipt" && supplierId ? supplierId : null,
      recipient: kind === "issue" ? recipient : null,
      documentNumber: documentNumber || null,
      note: note || null,
      lines: lines.map((line) => ({
        inventoryItemId: line.inventoryItemId,
        quantity: line.quantity,
        unitCost: kind === "receipt" ? line.unitCost || "0" : "0",
      })),
    };
    setBusy(true);
    setError("");
    const { ok, data } = await api("/api/inventory/warehouse-documents", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (!ok) {
      setError(DOC_ERRORS[(data as { error?: string }).error ?? ""] ?? warehouseErrorMessage((data as { error?: string }).error));
      return;
    }
    setLines([newLine()]);
    setSupplierId("");
    setRecipient("");
    setDocumentNumber("");
    setNote("");
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
      <form onSubmit={submit} className="min-w-0 space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="نوع سند">
          <button type="button" className={kindChipClass(kind === "receipt")} aria-pressed={kind === "receipt"} onClick={() => setKind("receipt")}>
            {KIND_LABELS.receipt}
          </button>
          <button type="button" className={kindChipClass(kind === "issue")} aria-pressed={kind === "issue"} onClick={() => setKind("issue")}>
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

        <div className="min-w-0 space-y-2">
          <div className="grid grid-cols-[minmax(0,2fr)_minmax(90px,1fr)_minmax(110px,1fr)_40px] items-center gap-2 text-xs font-medium text-stone-500 dark:text-stone-400">
            <span>قلم انبار</span>
            <span>مقدار</span>
            {kind === "receipt" ? <span>قیمت واحد (ریال)</span> : <span>ارزش (محاسبه‌شده)</span>}
            <span className="sr-only">حذف</span>
          </div>
          {items === null ? (
            <div className="min-w-0 space-y-2">
              <LoadingSkeleton rows={2} label="در حال بارگذاری اقلام انبار" />
            </div>
          ) : (
            lines.map((line) => (
              <div key={line.key} className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(90px,1fr)_minmax(110px,1fr)_40px] items-center gap-2">
                <SearchableSelect value={line.inventoryItemId} onChange={(v) => updateLine(line.key, { inventoryItemId: v })} options={itemOptions} />
                <PersianNumberInput
                  className={inputClass}
                  dir="ltr"
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                  placeholder="۰"
                  aria-label="مقدار قلم"
                />
                {kind === "receipt" ? (
                  <PersianNumberInput
                    className={inputClass}
                    dir="ltr"
                    inputMode="numeric"
                    value={line.unitCost}
                    onChange={(e) => updateLine(line.key, { unitCost: e.target.value })}
                    placeholder="۰"
                    aria-label="قیمت واحد به ریال"
                  />
                ) : (
                  <span className="truncate text-xs tabular-nums text-muted-foreground">در لحظه ثبت</span>
                )}
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
            ))
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((current) => [...current, newLine()])}>
              <PlusIcon aria-hidden="true" className="size-4" />
              افزودن قلم
            </Button>
            {kind === "receipt" && receiptTotal !== null ? (
              <span className="text-sm font-semibold tabular-nums text-foreground">
                جمع: {money.format(receiptTotal)}
              </span>
            ) : null}
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
