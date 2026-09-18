"use client";

import { EmptyState, SectionCardSkeleton, StatusBadge, cardClass } from "../page-chrome";
import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { isoDateToJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { DownloadIcon, RefreshCwIcon } from "lucide-react";
import { api, ErrorBox, errorMessage, inputClass } from "../ui";

/**
 * «مدیریت فاکتورها» — the sales history as a managed list: search by customer
 * or invoice number, filter by settlement method, paginate, export. Same data
 * the issue screen posts to (/api/sales/invoices) — a second view over one
 * record, not a second record.
 */

interface InvoiceRow {
  id: string;
  orderNumber: number;
  total: number;
  closedAt: string;
  customerName: string | null;
  lineCount: number;
  paymentMethod: string | null;
}

const METHOD_LABEL: Record<string, string> = { cash: "نقدی", bank: "بانکی", credit: "اعتباری" };
type MethodFilter = "" | "cash" | "bank" | "credit";

function fmtJalali(iso: string | null): string {
  if (!iso) return "—";
  const j = isoDateToJalali(iso.slice(0, 10));
  if (!j) return "—";
  return toPersianDigits(`${j.jy}/${String(j.jm).padStart(2, "0")}/${String(j.jd).padStart(2, "0")}`);
}

const chipClass = (active: boolean) =>
  `min-h-[44px] rounded-xl border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/40 ${
    active
      ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-950 dark:text-amber-200"
      : "border-border bg-card text-foreground  hover:border-amber-300 dark:hover:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-500/10 hover:text-foreground dark:hover:text-stone-100"
  }`;

export function InvoiceManagementView() {
  const money = useMoney();
  const [q, setQ] = useState("");
  const [method, setMethod] = useState<MethodFilter>("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const pageSize = 20;

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (q.trim()) params.set("q", q.trim());
    if (method) params.set("method", method);
    api<{ invoices: InvoiceRow[]; count: number; error?: string }>(`/api/sales/invoices?${params}`).then(({ ok, data }) => {
      if (ok) {
        setRows(data.invoices);
        setCount(data.count);
      } else {
        setError(errorMessage(data.error));
      }
    });
  }, [q, method, page]);

  useEffect(() => {
    setRows(null);
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q, refreshKey]);

  useEffect(() => {
    setPage(1);
  }, [q, method]);

  const pageCount = Math.max(Math.ceil(count / pageSize), 1);

  function downloadCsv() {
    if (!rows) return;
    const head = ["شماره فاکتور", "مشتری", "اقلام", "روش پرداخت", "مبلغ (ریال)", "تاریخ ثبت"];
    const body = rows.map((r) => [
      String(r.orderNumber),
      r.customerName ?? "",
      String(r.lineCount),
      METHOD_LABEL[r.paymentMethod ?? ""] ?? r.paymentMethod ?? "",
      String(r.total),
      r.closedAt ? r.closedAt.slice(0, 10) : "",
    ]);
    const csv = [head, ...body].map((line) => line.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "invoices.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className={`${cardClass} p-4 sm:p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">مدیریت فاکتور</p>
          <h2 className="mt-1 font-semibold text-foreground dark:text-stone-50">همه فاکتورها</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            فهرست فاکتورهای ثبت‌شده این شعبه؛ جست‌وجو، فیلتر روش پرداخت و خروجی برای پیگیری و بایگانی.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted"
          >
            <RefreshCwIcon aria-hidden="true" className="size-4" />
            به‌روزرسانی
          </button>
          <button
            type="button"
            onClick={downloadCsv}
            disabled={!rows || rows.length === 0}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
          >
            <DownloadIcon aria-hidden="true" className="size-4" />
            دانلود و چاپ
          </button>
        </div>
      </div>

      <ErrorBox>{error}</ErrorBox>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="روش پرداخت">
          <button type="button" aria-pressed={method === ""} className={chipClass(method === "")} onClick={() => setMethod("")}>همه</button>
          <button type="button" aria-pressed={method === "cash"} className={chipClass(method === "cash")} onClick={() => setMethod("cash")}>نقدی</button>
          <button type="button" aria-pressed={method === "bank"} className={chipClass(method === "bank")} onClick={() => setMethod("bank")}>بانکی</button>
          <button type="button" aria-pressed={method === "credit"} className={chipClass(method === "credit")} onClick={() => setMethod("credit")}>اعتباری</button>
        </div>
        <input
          className={`${inputClass} h-11 ms-auto w-44 sm:w-64`}
          placeholder="جست‌وجوی مشتری یا شماره فاکتور…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="mt-4">
        {!rows ? (
          <SectionCardSkeleton rows={5} />
        ) : rows.length === 0 ? (
          <EmptyState>فاکتوری با این مشخصات ثبت نشده است.</EmptyState>
        ) : (
          <>
            <div className="hidden overflow-x-auto rounded-xl border border-border/80 dark:border-stone-500/30 lg:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/60 dark:bg-stone-500/10">
                    <th className="py-3 pe-3 ps-4 text-start text-xs font-medium text-muted-foreground sm:text-sm">#</th>
                    <th className="py-3 pe-3 text-start text-xs font-medium text-muted-foreground sm:text-sm">شماره فاکتور</th>
                    <th className="py-3 pe-3 text-start text-xs font-medium text-muted-foreground sm:text-sm">مشتری</th>
                    <th className="py-3 pe-3 text-start text-xs font-medium text-muted-foreground sm:text-sm">اقلام</th>
                    <th className="py-3 pe-3 text-start text-xs font-medium text-muted-foreground sm:text-sm">روش پرداخت</th>
                    <th className="py-3 pe-3 text-start text-xs font-medium text-muted-foreground sm:text-sm">مبلغ</th>
                    <th className="py-3 pe-4 text-start text-xs font-medium text-muted-foreground sm:text-sm">تاریخ ثبت</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, index) => (
                    <tr key={r.id} className="border-b border-border transition-colors last:border-b-0 hover:bg-muted/60 dark:hover:bg-stone-500/10">
                      <td className="py-3 pe-3 ps-4 text-muted-foreground">{toPersianDigits((page - 1) * pageSize + index + 1)}</td>
                      <td className="whitespace-nowrap py-3 pe-3 font-semibold">{toPersianDigits(r.orderNumber)}</td>
                      <td className="max-w-48 truncate py-3 pe-3 font-medium">{r.customerName ?? "بدون مشتری"}</td>
                      <td className="py-3 pe-3 text-muted-foreground">{toPersianDigits(r.lineCount)} قلم</td>
                      <td className="py-3 pe-3">
                        {r.paymentMethod === "credit" ? (
                          <StatusBadge tone="active">{METHOD_LABEL.credit}</StatusBadge>
                        ) : (
                          <StatusBadge tone="neutral">{METHOD_LABEL[r.paymentMethod ?? ""] ?? "—"}</StatusBadge>
                        )}
                      </td>
                      <td className="whitespace-nowrap py-3 pe-3 font-semibold">{money.format(r.total)}</td>
                      <td className="whitespace-nowrap py-3 pe-4 text-muted-foreground">{fmtJalali(r.closedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-3 lg:hidden">
              {rows.map((r) => (
                <article key={r.id} className="rounded-xl border border-border/80 bg-muted p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-bold">{r.customerName ?? "بدون مشتری"}</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        فاکتور {toPersianDigits(r.orderNumber)} · {toPersianDigits(r.lineCount)} قلم · {fmtJalali(r.closedAt)}
                      </p>
                    </div>
                    <span className="whitespace-nowrap font-bold">{money.format(r.total)}</span>
                  </div>
                  <div className="mt-2">
                    {r.paymentMethod === "credit" ? (
                      <StatusBadge tone="active">{METHOD_LABEL.credit}</StatusBadge>
                    ) : (
                      <StatusBadge tone="neutral">{METHOD_LABEL[r.paymentMethod ?? ""] ?? "—"}</StatusBadge>
                    )}
                  </div>
                </article>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">
                صفحهٔ {toPersianDigits(page)} از {toPersianDigits(pageCount)} — {toPersianDigits(count)} نتیجه
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className="inline-flex min-h-10 items-center rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                >
                  قبلی
                </button>
                <button
                  type="button"
                  disabled={page >= pageCount}
                  onClick={() => setPage((p) => p + 1)}
                  className="inline-flex min-h-10 items-center rounded-lg border border-border px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                >
                  بعدی
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
