"use client";

/**
 * Phase 42b — «رسید و حواله‌های انبار»: the ledger of the RETAIL warehouse's
 * own documents. Filters by kind (رسید/حواله) and warehouse, plus a search
 * over number/recipient/note; each row opens the document's lines (with lot,
 * expiry, cost and totals) in a detail dialog.
 */
import { ArrowUpCircleIcon, ArrowDownCircleIcon, EyeIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { api, inputClass } from "../ui";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "../page-chrome";
import { type Warehouse } from "./warehouses-section";

interface WarehouseDocument {
  id: string;
  kind: "receipt" | "issue";
  location_id: string;
  location_name: string;
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
  tracking: string;
  lot_number: string | null;
  expiry_date: string | null;
  quantity: string;
  unit_cost: string;
  value_rial: string;
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
  `min-h-[44px] rounded-xl border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-amber-400/40 ${
    active
      ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-950 dark:text-amber-200"
      : "border-border bg-card text-stone-700 dark:text-stone-300 hover:border-amber-300 dark:hover:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-500/10 hover:text-stone-950 dark:hover:text-stone-100"
  }`;

export function DocumentsSection() {
  const money = useMoney();
  const [documents, setDocuments] = useState<WarehouseDocument[] | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [locationId, setLocationId] = useState("");
  const [search, setSearch] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);

  useEffect(() => {
    api<{ warehouses: Warehouse[] }>("/api/stock/warehouses").then(({ ok, data }) => {
      if (ok) setWarehouses(data.warehouses);
    });
  }, []);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (kindFilter !== "all") params.set("kind", kindFilter);
    if (locationId) params.set("locationId", locationId);
    if (search.trim()) params.set("search", search.trim());
    api<{ documents: WarehouseDocument[] }>(`/api/stock/warehouse-documents?${params.toString()}`).then(
      ({ ok, data }) => setDocuments(ok ? data.documents : []),
    );
  }, [kindFilter, locationId, search]);
  useEffect(load, [load]);

  const openDetail = useCallback((id: string) => {
    setDetailId(id);
    setDetail(null);
    api<DetailResponse>(`/api/stock/warehouse-documents/${id}`).then(({ ok, data }) => {
      if (ok) setDetail(data);
    });
  }, []);

  const locationName = useMemo(() => {
    if (!locationId) return null;
    return warehouses.find((w) => w.id === locationId)?.name ?? null;
  }, [locationId, warehouses]);

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سند انبار</p>
            <h2 className="mt-1 font-semibold text-foreground">رسید و حواله‌های انبار</h2>
          </div>
        }
        description="همهٔ سندهای ورودی (رسید) و خروجی (حواله) که در انبارهای این کسب‌وکار ثبت شده‌اند."
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
          <div className="w-full sm:w-56">
            <SearchableSelect
              value={locationId}
              onChange={setLocationId}
              options={[
                { value: "", label: "همهٔ انبارها" },
                ...warehouses.map((w) => ({ value: w.id, label: w.name })),
              ]}
            />
          </div>
          <div className="relative w-full sm:w-64">
            <SearchIcon aria-hidden="true" className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground" />
            <input
              className={`${inputClass} ps-9`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="جستجوی شماره سند / گیرنده / یادداشت"
              aria-label="جستجوی سندها"
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard flush>
        {documents === null ? (
          <div className="p-4 sm:p-5">
            <LoadingSkeleton rows={5} label="در حال بارگذاری سندهای انبار" />
          </div>
        ) : documents.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>
              {kindFilter === "all" && !locationId && !search
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
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:px-5 sm:text-sm">نوع</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:px-5 sm:text-sm">انبار</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:px-5 sm:text-sm">گیرنده / شماره سند</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:px-5 sm:text-sm">اقلام</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:px-5 sm:text-sm">مبلغ</th>
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
                      if (e.key === "Enter") openDetail(doc.id);
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
                      {doc.recipient}
                      {doc.document_number ? (
                        <span className="text-xs text-muted-foreground"> · سند {toPersianDigits(doc.document_number)}</span>
                      ) : null}
                      {!doc.recipient && !doc.document_number ? "—" : null}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{toPersianDigits(String(doc.line_count))}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-medium tabular-nums">{money.format(Number(doc.total_value_rial))}</td>
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

      <Dialog open={detailId !== null} onOpenChange={(open) => !open && setDetailId(null)}>
        <DialogContent className="max-w-2xl">
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

          {detail === null ? (
            <LoadingSkeleton rows={4} label="در حال بارگذاری جزئیات سند" />
          ) : (
            <div className="space-y-4">
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <p className="text-muted-foreground">
                  گیرنده/مقصد: <span className="text-foreground">{detail.document.recipient ?? "—"}</span>
                </p>
                {detail.document.note ? (
                  <p className="text-muted-foreground">
                    یادداشت: <span className="text-foreground">{detail.document.note}</span>
                  </p>
                ) : null}
              </div>
              <div className="overflow-x-auto rounded-xl border border-border/80">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-border bg-stone-50 dark:bg-stone-900/40">
                      <th className="px-3 py-2.5 text-start text-xs font-medium text-stone-500 dark:text-stone-400">کالا</th>
                      <th className="px-3 py-2.5 text-start text-xs font-medium text-stone-500 dark:text-stone-400">بچ/لات</th>
                      <th className="px-3 py-2.5 text-start text-xs font-medium text-stone-500 dark:text-stone-400">انقضا</th>
                      <th className="px-3 py-2.5 text-start text-xs font-medium text-stone-500 dark:text-stone-400">تعداد</th>
                      <th className="px-3 py-2.5 text-start text-xs font-medium text-stone-500 dark:text-stone-400">بهای واحد</th>
                      <th className="px-3 py-2.5 text-start text-xs font-medium text-stone-500 dark:text-stone-400">ارزش</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line) => (
                      <tr key={line.id} className="border-b border-border/80 last:border-b-0">
                        <td className="px-3 py-2.5">{line.item_name}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">{line.lot_number ?? "—"}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">
                          {line.expiry_date ? formatJalali(line.expiry_date) : "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{formatQuantity(line.quantity)}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{money.format(Number(line.unit_cost))}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 font-medium tabular-nums">{money.format(Number(line.value_rial))}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-stone-50/60 dark:bg-stone-900/30">
                      <td colSpan={5} className="px-3 py-2.5 text-xs font-semibold text-stone-600 dark:text-stone-300">
                        جمع کل
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 font-semibold tabular-nums">
                        {money.format(Number(detail.document.total_value_rial))}
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
