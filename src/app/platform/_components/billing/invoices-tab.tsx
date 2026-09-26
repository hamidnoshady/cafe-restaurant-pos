"use client";

/**
 * فاکتورها — the immutable invoice ledger. Line items are snapshotted at issue
 * time (they never re-price), invoice numbers are sequential
 * (INV-<year><month>-<seq>), and each row expands in place — one round trip,
 * lines included. Read-only: an invoice is only ever written by the
 * subscription/payment services that created it.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDownIcon, ChevronLeftIcon, RefreshCwIcon } from "lucide-react";
import { api, Card, ErrorBox, selectClass, SkeletonRows } from "../../ui";
import { PlatformStatusBadge } from "@/components/platform/status-badge";
import { formatJalali } from "@/lib/jalali";
import { tomanLabel } from "@/lib/platform-money";

interface InvoiceLine {
  id: string;
  kind: string;
  description: string;
  quantity: number;
  unitAmountRial: number;
  amountRial: number;
  featureKey: string | null;
}

interface Invoice {
  id: string;
  businessId: string;
  businessName: string | null;
  invoiceNumber: string;
  status: "draft" | "open" | "paid" | "partially_paid" | "overdue" | "void";
  subtotalRial: number;
  discountRial: number;
  taxRial: number;
  totalRial: number;
  paidRial: number;
  dueAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  reference: string;
  note: string | null;
  createdAt: string;
  lines?: InvoiceLine[];
}

const STATUS_LABELS: Record<Invoice["status"], string> = {
  draft: "پیش‌نویس",
  open: "باز",
  paid: "تسویه شده",
  partially_paid: "تسویه جزئی",
  overdue: "معوق",
  void: "باطل",
};
const STATUS_TONES: Record<Invoice["status"], "success" | "info" | "warning" | "danger" | "muted" | "neutral"> = {
  draft: "muted",
  open: "info",
  paid: "success",
  partially_paid: "warning",
  overdue: "danger",
  void: "muted",
};

const STATUS_OPTIONS = [
  { key: "", label: "همهٔ وضعیت‌ها" },
  { key: "open", label: "باز" },
  { key: "partially_paid", label: "تسویه جزئی" },
  { key: "paid", label: "تسویه شده" },
  { key: "overdue", label: "معوق" },
  { key: "void", label: "باطل" },
];

export function BillingInvoicesTab() {
  const [status, setStatus] = useState("");
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    params.set("withLines", "1");
    const { ok, data } = await api<{ invoices: Invoice[]; error?: string }>(
      `/api/platform/billing/invoices?${params.toString()}`,
    );
    if (ok) setInvoices(data.invoices);
    else setError(data.error ?? "بارگذاری فاکتورها ممکن نشد.");
  }, [status]);

  useEffect(() => {
    setInvoices(null);
    void load();
  }, [load]);

  const outstanding = (invoices ?? []).reduce(
    (sum, i) => (["open", "partially_paid", "overdue"].includes(i.status) ? sum + (i.totalRial - i.paidRial) : sum),
    0,
  );

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <Card title="فاکتورها">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <select
              className={selectClass + " h-9 w-44"}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-lg border border-border p-2 text-foreground hover:bg-muted"
              aria-label="بازخوانی"
            >
              <RefreshCwIcon className="size-4" />
            </button>
          </div>
          {invoices && (
            <p className="text-xs text-muted-foreground">
              مجموع مطالبات باز: <span className="font-medium text-foreground">{tomanLabel(outstanding)}</span>
            </p>
          )}
        </div>

        {!invoices ? (
          <SkeletonRows rows={6} />
        ) : invoices.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">فاکتوری با این فیلتر یافت نشد.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-right text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-1">شماره</th>
                  <th className="py-2">کسب‌وکار</th>
                  <th className="py-2">وضعیت</th>
                  <th className="py-2">مبلغ کل</th>
                  <th className="py-2">پرداخت‌شده</th>
                  <th className="py-2">سرسید</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => {
                  const isOpen = expanded === invoice.id;
                  return (
                    <Fragment key={invoice.id}>
                      <tr className="border-b border-border">
                        <td className="py-2 pr-1 font-mono text-xs" dir="ltr">
                          {invoice.invoiceNumber}
                        </td>
                        <td className="py-2">
                          <Link
                            href={`/platform/businesses/${invoice.businessId}/billing`}
                            className="underline-offset-4 hover:underline"
                          >
                            {invoice.businessName ?? invoice.businessId}
                          </Link>
                        </td>
                        <td className="py-2">
                          <PlatformStatusBadge
                            label={STATUS_LABELS[invoice.status]}
                            tone={STATUS_TONES[invoice.status]}
                          />
                        </td>
                        <td className="py-2 tabular-nums">{tomanLabel(invoice.totalRial)}</td>
                        <td className="py-2 tabular-nums">
                          {tomanLabel(invoice.paidRial)}
                          {invoice.paidRial > 0 && invoice.paidRial < invoice.totalRial && (
                            <span className="mr-1 text-xs text-amber-700 dark:text-amber-300">
                              (باقی‌مانده: {tomanLabel(invoice.totalRial - invoice.paidRial)})
                            </span>
                          )}
                        </td>
                        <td className="py-2 tabular-nums">
                          {invoice.dueAt ? formatJalali(invoice.dueAt) : "—"}
                        </td>
                        <td className="py-2 text-left">
                          <button
                            type="button"
                            onClick={() => setExpanded(isOpen ? null : invoice.id)}
                            className="rounded-lg border border-border px-2 py-1 text-xs text-foreground hover:bg-muted"
                            aria-expanded={isOpen}
                          >
                            {isOpen ? <ChevronDownIcon className="size-3.5" /> : <ChevronLeftIcon className="size-3.5" />}
                            ردیف‌ها
                          </button>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b border-border bg-muted/30">
                          <td colSpan={7} className="px-3 py-3">
                            {invoice.lines && invoice.lines.length > 0 ? (
                              <table className="w-full text-xs">
                                <thead className="text-right text-muted-foreground">
                                  <tr>
                                    <th className="py-1 pr-1">شرح</th>
                                    <th className="py-1">نوع</th>
                                    <th className="py-1">تعداد</th>
                                    <th className="py-1">مبلغ واحد</th>
                                    <th className="py-1">مبلغ کل</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {invoice.lines.map((line) => (
                                    <tr key={line.id}>
                                      <td className="py-1 pr-1">{line.description}</td>
                                      <td className="py-1">{line.kind}</td>
                                      <td className="py-1 tabular-nums">{line.quantity}</td>
                                      <td className="py-1 tabular-nums">{tomanLabel(line.unitAmountRial)}</td>
                                      <td className="py-1 tabular-nums">{tomanLabel(line.amountRial)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            ) : (
                              <p className="text-center text-xs text-muted-foreground">ردیفی ثبت نشده است.</p>
                            )}
                            <p className="mt-2 text-xs text-muted-foreground">
                              مرجع: <span className="font-mono" dir="ltr">{invoice.reference}</span>
                              {invoice.periodStart && invoice.periodEnd && (
                                <>
                                  {" • "}دوره: {formatJalali(invoice.periodStart)} تا {formatJalali(invoice.periodEnd)}
                                </>
                              )}
                              {invoice.note ? <>{" • "}{invoice.note}</> : null}
                            </p>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
