"use client";

import {LoadingSkeleton, cardClass } from "@/app/dashboard/page-chrome";

import { useCallback, useEffect, useState } from "react";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { REPAIR_STATUS_LABELS, type RepairStatus } from "./watch-manager";
import { api } from "../ui";

type WarrantyState = "active" | "expiring" | "expired" | "none";

const WARRANTY_STATE_LABELS: Record<WarrantyState, string> = {
  active: "معتبر",
  expiring: "رو به پایان",
  expired: "منقضی",
  none: "بدون گارانتی",
};

const WARRANTY_BADGE_CLASS: Record<WarrantyState, string> = {
  active: "bg-emerald-100 text-emerald-900",
  expiring: "bg-amber-100 text-amber-900",
  expired: "bg-stone-200 text-stone-600",
  none: "bg-stone-100 text-stone-500",
};

interface WarrantyRow {
  serialId: string;
  serialNumber: string;
  itemName: string;
  soldAt: string | null;
  startDate: string;
  endDate: string;
  months: number;
  state: WarrantyState;
}

interface RepairRow {
  ticketId: string;
  ticketNumber: number;
  itemDescription: string;
  status: RepairStatus;
  underWarranty: boolean;
  net: number;
  partsCost: number;
}

interface ReportPayload {
  warranty: { rows: WarrantyRow[]; counts: Record<WarrantyState, number> };
  repairs: {
    rows: RepairRow[];
    byStatus: Record<string, number>;
    totals: { revenue: number; partsCost: number; margin: number };
  };
}

export function ReportsSection() {
  const money = useMoney();
  const [data, setData] = useState<ReportPayload | null>(null);

  const load = useCallback(() => {
    api<ReportPayload>("/api/watch/reports").then(({ ok, data: payload }) => {
      if (ok) setData(payload);
    });
  }, []);
  useEffect(load, [load]);

  if (!data) return <LoadingSkeleton rows={3} />;

  return (
    <div className="min-w-0 space-y-4">
      <section aria-labelledby="watch-warranty-heading" className={`min-w-0 overflow-hidden ${cardClass} `}>
        <div className="border-b border-stone-200/80 px-4 py-4 sm:px-5">
          <h2 id="watch-warranty-heading" className="font-semibold text-stone-950">
            گارانتی‌ها
          </h2>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {(["active", "expiring", "expired"] as WarrantyState[]).map((state) => (
              <span key={state} className={`rounded-full px-2 py-0.5 font-medium ${WARRANTY_BADGE_CLASS[state]}`}>
                {WARRANTY_STATE_LABELS[state]}: {toPersianDigits(String(data.warranty.counts[state] ?? 0))}
              </span>
            ))}
          </div>
        </div>

        <ul className="divide-y divide-stone-200/80">
          {data.warranty.rows.map((row) => (
            <li key={row.serialId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs sm:px-5">
              <span className="font-medium text-stone-800">
                {row.itemName} — <span dir="ltr">{row.serialNumber}</span>
              </span>
              <span className="text-stone-600">
                {formatJalali(row.startDate, { withMonthName: true })} تا{" "}
                {formatJalali(row.endDate, { withMonthName: true })} (
                {toPersianDigits(String(row.months))} ماه)
                <span className={`ms-2 rounded-full px-2 py-0.5 font-medium ${WARRANTY_BADGE_CLASS[row.state]}`}>
                  {WARRANTY_STATE_LABELS[row.state]}
                </span>
              </span>
            </li>
          ))}
          {data.warranty.rows.length === 0 ? (
            <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">هنوز گارانتی‌ای صادر نشده است.</li>
          ) : null}
        </ul>
      </section>

      <section aria-labelledby="watch-repair-report-heading" className={`min-w-0 overflow-hidden ${cardClass} `}>
        <div className="border-b border-stone-200/80 px-4 py-4 sm:px-5">
          <h2 id="watch-repair-report-heading" className="font-semibold text-stone-950">
            تعمیرات
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            درآمد و بهای قطعات فقط برای تیکت‌های بسته‌شده محاسبه می‌شود؛ تیکت باز هنوز درآمد نیست. تعمیر گارانتی
            حاشیهٔ منفی دارد، چون قطعه مصرف شده اما مبلغی دریافت نشده است.
          </p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {Object.entries(data.repairs.byStatus).map(([status, count]) => (
              <span key={status} className="rounded-full bg-stone-100 px-2 py-0.5 font-medium text-stone-700">
                {REPAIR_STATUS_LABELS[status as RepairStatus] ?? status}: {toPersianDigits(String(count))}
              </span>
            ))}
          </div>
          <dl className="mt-3 grid gap-x-5 gap-y-2 text-xs text-stone-600 sm:grid-cols-3">
            <div>
              <dt className="text-stone-500">درآمد تعمیرات</dt>
              <dd className="mt-0.5 font-medium text-stone-700">{money.format(data.repairs.totals.revenue)}</dd>
            </div>
            <div>
              <dt className="text-stone-500">بهای قطعات</dt>
              <dd className="mt-0.5 font-medium text-stone-700">{money.format(data.repairs.totals.partsCost)}</dd>
            </div>
            <div>
              <dt className="text-stone-500">حاشیه</dt>
              <dd className="mt-0.5 font-medium text-stone-700">{money.format(data.repairs.totals.margin)}</dd>
            </div>
          </dl>
        </div>

        <ul className="divide-y divide-stone-200/80">
          {data.repairs.rows.map((row) => (
            <li key={row.ticketId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs sm:px-5">
              <span className="font-medium text-stone-800">
                تیکت {formatPersianNumber(row.ticketNumber)} — {row.itemDescription}
                {row.underWarranty ? (
                  <span className="ms-2 rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-900">
                    گارانتی
                  </span>
                ) : null}
              </span>
              <span className="text-stone-600">
                {REPAIR_STATUS_LABELS[row.status]} — دریافتی {money.format(row.net)} / بهای قطعات{" "}
                {money.format(row.partsCost)}
              </span>
            </li>
          ))}
          {data.repairs.rows.length === 0 ? (
            <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">تیکتی ثبت نشده است.</li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}
