"use client";

/**
 * Phase 42 — «رسید و حواله‌های انبار»: the ledger of the warehouse's own
 * documents. Filters by kind (رسید/حواله) and warehouse; each row opens the
 * document's lines in a detail dialog.
 */
import { ArrowUpCircleIcon, ArrowDownCircleIcon, EyeIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { api } from "../ui";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "../page-chrome";
import { type Warehouse } from "./warehouses-section";

interface WarehouseDocument {
  id: string;
  kind: "receipt" | "issue";
  location_id: string;
  location_name: string;
  supplier_name: string | null;
  recipient: string | null;
  document_number: string | null;
  note: string | null;
  total_value_rial: string;
  created_at: string;
  created_by_name: string | null;
  line_count: number;
}

interface DocumentLine {
  id: string;
  item_name: string;
  unit: string;
  quantity: string;
  unit_cost: string;
  value_rial: string;
  note: string | null;
}

interface DetailResponse {
  document: Omit<WarehouseDocument, "line_count">;
  lines: DocumentLine[];
}

type KindFilter = "all" | "receipt" | "issue";

const KIND_FILTERS: Array<{ key: KindFilter; label: string }> = [
  { key: "all", label: "همه" },
  { key: "receipt", label: "رسید" },
  { key: "issue", label: "حواله" },
];

const chipClass = (active: boolean) =>
  `min-h-[44px] rounded-xl border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/40 ${
    active
      ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-950 dark:text-amber-200"
      : "border-border bg-card text-stone-700 dark:text-stone-300 hover:border-amber-300 dark:hover:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-500/10 hover:text-stone-950 dark:hover:text-stone-100"
  }`;

export function DocumentsSection() {
  const money = useMoney();
  const [documents, setDocuments] = useState<WarehouseDocument[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [locationId, setLocationId] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  // The id of the detail request in flight — a slow response for a previously
  // opened document must not overwrite the one the user is looking at now.
  const detailRequestRef = useRef<string | null>(null);

  useEffect(() => {
    api<{ warehouses: Warehouse[] }>("/api/inventory/warehouses").then(({ ok, data }) => {
      if (ok) setWarehouses(data.warehouses);
    });
  }, []);

  // Cancellation-guarded: switching filters quickly must not let a stale
  // response land on top of the newer one.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (kindFilter !== "all") params.set("kind", kindFilter);
    if (locationId) params.set("locationId", locationId);
    api<{ documents: WarehouseDocument[] }>(`/api/inventory/warehouse-documents?${params.toString()}`).then(
      ({ ok, data }) => {
        if (cancelled) return;
        setLoadFailed(!ok);
        setDocuments(ok ? data.documents : []);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kindFilter, locationId, reloadKey]);

  const openDetail = useCallback((id: string) => {
    setDetailId(id);
    setDetail(null);
    setDetailFailed(false);
    detailRequestRef.current = id;
    api<DetailResponse>(`/api/inventory/warehouse-documents/${id}`).then(({ ok, data }) => {
      if (detailRequestRef.current !== id) return;
      if (ok) setDetail(data);
      else setDetailFailed(true);
    });
  }, []);

  const warehouseOptions = useMemo(
    () => [{ value: "", label: "همهٔ انبارها" }, ...warehouses.map((w) => ({ value: w.id, label: w.name }))],
    [warehouses],
  );

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سند انبار</p>
            <h2 className="mt-1 font-semibold text-foreground">رسید و حواله‌های انبار</h2>
          </div>
        }
        description="همهٔ سندهای ورودی (رسید) و خروجی (حواله) که در انبارها ثبت شده‌اند."
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-2" role="group" aria-label="نوع سند">
            {KIND_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={chipClass(kindFilter === f.key)}
                aria-pressed={kindFilter === f.key}
                onClick={() => setKindFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="w-full sm:w-64">
            <SearchableSelect
              value={locationId}
              onChange={setLocationId}
              options={warehouseOptions}
              ariaLabel="فیلتر بر اساس انبار"
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard flush>
        {documents === null ? (
          <div className="p-4 sm:p-5">
            <LoadingSkeleton rows={5} label="در حال بارگذاری سندهای انبار" />
          </div>
        ) : loadFailed ? (
          <div className="p-4 sm:p-5">
            <EmptyState>
              <span className="block">دریافت سندهای انبار ناموفق بود.</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => setReloadKey((k) => k + 1)}
              >
                <RefreshCwIcon aria-hidden="true" className="size-4" />
                تلاش دوباره
              </Button>
            </EmptyState>
          </div>
        ) : documents.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>
              {kindFilter === "all" && !locationId
                ? "هنوز رسید یا حواله‌ای ثبت نشده است. از «ثبت رسید انبار/حواله» اولین سند را بسازید."
                : "سندی با این فیلترها پیدا نشد."}
            </EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border bg-stone-50 dark:bg-stone-900/40">
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:px-5 sm:text-sm">تاریخ</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:text-sm">نوع</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:text-sm">انبار</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:text-sm">طرف‌حساب</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:text-sm">اقلام</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:text-sm">مبلغ</th>
                  <th className="py-3 pe-4 text-end text-xs font-medium text-stone-500 dark:text-stone-400 sm:pe-5 sm:text-sm">جزئیات</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr
                    key={doc.id}
                    className="cursor-pointer border-b border-border/80 transition-colors last:border-b-0 hover:bg-stone-50/70 dark:hover:bg-stone-900/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/45 dark:focus-visible:ring-amber-400/45 active:scale-[0.99]"
                    onClick={() => openDetail(doc.id)}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      // Space activates a button-role element too; prevent the
                      // page from scrolling instead of opening the dialog.
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openDetail(doc.id);
                      }
                    }}
                  >
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums sm:px-5">{formatJalali(doc.created_at)}</td>
                    <td className="px-4 py-3">
                      {doc.kind === "receipt" ? (
                        <StatusBadge tone="positive">
                          <ArrowUpCircleIcon aria-hidden="true" className="size-3.5" />
                          رسید
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">
                          <ArrowDownCircleIcon aria-hidden="true" className="size-3.5" />
                          حواله
                        </StatusBadge>
                      )}
                    </td>
                    <td className="px-4 py-3">{doc.location_name}</td>
                    <td className="max-w-[220px] truncate px-4 py-3">
                      {doc.kind === "receipt" ? doc.supplier_name : doc.recipient}
                      {doc.document_number ? (
                        <span className="text-xs text-muted-foreground"> · سند {toPersianDigits(doc.document_number)}</span>
                      ) : null}
                      {!(doc.kind === "receipt" ? doc.supplier_name : doc.recipient) && !doc.document_number ? "—" : null}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{toPersianDigits(String(doc.line_count))}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-medium tabular-nums">{money.formatText(doc.total_value_rial)}</td>
                    <td className="py-3 pe-4 text-end sm:pe-5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:bg-stone-50 dark:hover:bg-stone-900/40 hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          openDetail(doc.id);
                        }}
                        aria-label={`جزئیات سند ${doc.kind === "receipt" ? "رسید" : "حواله"} ${doc.location_name}`}
                        title="جزئیات سند"
                      >
                        <EyeIcon aria-hidden="true" className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <Dialog
        open={detailId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDetailId(null);
            detailRequestRef.current = null;
          }
        }}
      >
        {/* sm:max-w-2xl (not max-w-2xl): the base class must keep the mobile
            max-w-[calc(100%-2rem)] margin and only widen from sm up. */}
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {detail?.document.kind === "issue" ? "حواله انبار" : "رسید انبار"}
              {detail?.document.document_number ? ` — سند ${toPersianDigits(detail.document.document_number)}` : ""}
            </DialogTitle>
            <DialogDescription>
              {detail
                ? `${detail.document.location_name} · ${formatJalali(detail.document.created_at)}${
                    detail.document.created_by_name ? ` · ${detail.document.created_by_name}` : ""
                  }`
                : " "}
            </DialogDescription>
          </DialogHeader>

          {detailFailed ? (
            <EmptyState>
              <span className="block">دریافت جزئیات سند ناموفق بود.</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => detailId && openDetail(detailId)}
              >
                <RefreshCwIcon aria-hidden="true" className="size-4" />
                تلاش دوباره
              </Button>
            </EmptyState>
          ) : detail === null ? (
            <LoadingSkeleton rows={4} label="در حال بارگذاری جزئیات سند" />
          ) : (
            <div className="space-y-4">
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <p className="text-muted-foreground">
                  {detail.document.kind === "receipt" ? "تأمین‌کننده" : "گیرنده/مقصد"}:{" "}
                  <span className="text-foreground">
                    {detail.document.kind === "receipt"
                      ? (detail.document.supplier_name ?? "—")
                      : (detail.document.recipient ?? "—")}
                  </span>
                </p>
                {detail.document.note ? (
                  <p className="text-muted-foreground">
                    یادداشت: <span className="text-foreground">{detail.document.note}</span>
                  </p>
                ) : null}
              </div>
              <div className="overflow-x-auto rounded-xl border border-border/80">
                <table className="w-full min-w-[480px] text-sm">
                  <thead>
                    <tr className="border-b border-border bg-stone-50 dark:bg-stone-900/40">
                      <th className="px-3 py-2.5 text-start text-xs font-medium text-stone-500 dark:text-stone-400">قلم</th>
                      <th className="px-3 py-2.5 text-start text-xs font-medium text-stone-500 dark:text-stone-400">مقدار</th>
                      <th className="px-3 py-2.5 text-start text-xs font-medium text-stone-500 dark:text-stone-400">قیمت واحد</th>
                      <th className="px-3 py-2.5 text-start text-xs font-medium text-stone-500 dark:text-stone-400">ارزش</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line) => (
                      <tr key={line.id} className="border-b border-border/80 last:border-b-0">
                        <td className="px-3 py-2.5">{line.item_name}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">
                          {formatQuantity(line.quantity)} {line.unit}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{money.formatText(line.unit_cost)}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 font-medium tabular-nums">{money.formatText(line.value_rial)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-stone-50/60 dark:bg-stone-900/30">
                      <td colSpan={3} className="px-3 py-2.5 text-xs font-semibold text-stone-600 dark:text-stone-300">
                        جمع کل
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 font-semibold tabular-nums">
                        {money.formatText(detail.document.total_value_rial)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
