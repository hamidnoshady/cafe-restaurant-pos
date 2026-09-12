"use client";

import { EmptyState, SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Phase 14 — consolidated numbers across a business's own branches.
 *
 * Not the Phase 9 cross-server comparison (dashboard/locations): this reads
 * /api/reports/business-overview, which queries the same reporting views every
 * per-branch report already reads, so these numbers can never disagree with a
 * branch's own reports.
 */
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { ErrorBox, api, errorMessage } from "../ui";
import { ReportTable } from "./report-table";

interface BranchRow {
  locationId: string;
  locationName: string;
  isActive: boolean;
  orderCount: number;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  cogs: number;
  wasteCost: number;
}

interface Overview {
  branches: BranchRow[];
  consolidated: Omit<BranchRow, "locationId" | "locationName" | "isActive">;
}

export function BranchOverviewSection() {
  // This used to keep a module-level `money()` that re-implemented what the
  // context's own `format` already does, and had to be handed `moneyApi.unit`
  // at every one of its twelve call sites. The context formats it.
  const money = useMoney();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const result = await api<Overview & { error?: string }>("/api/reports/business-overview");
      if (result.ok) setData(result.data);
      else setError(errorMessage(result.data.error));
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return <SectionCardSkeleton rows={4} label="در حال بارگذاری مقایسه شعب" />;
  }

  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!data) return null;

  if (data.branches.length <= 1) {
    return (
      <SectionCard title="مقایسهٔ شعب">
        <EmptyState>
          این کسب‌وکار بیش از یک شعبه ندارد؛ مقایسه وقتی شعبهٔ دوم اضافه شود در دسترس خواهد بود.
        </EmptyState>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="مقایسهٔ شعب" description="اعداد تجمیعی بر پایهٔ گزارش‌های فعلی هر شعبه." flush>
      <ReportTable
        caption="مقایسه عملکرد شعب"
        rows={data.branches}
        rowKey={(branch) => branch.locationId}
        cardTitle={(branch) => (
          <span className="flex items-center gap-2">
            {branch.locationName}
            {!branch.isActive ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                غیرفعال
              </span>
            ) : null}
          </span>
        )}
        columns={[
          {
            key: "branch",
            header: "شعبه",
            cell: (branch) => (
              <span className="flex items-center gap-2 font-medium">
                {branch.locationName}
                {!branch.isActive ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    غیرفعال
                  </span>
                ) : null}
              </span>
            ),
          },
          {
            key: "orders",
            header: "تعداد سفارش",
            align: "end",
            numeric: true,
            cell: (branch) => toPersianDigits(String(branch.orderCount)),
          },
          {
            key: "subtotal",
            header: "فروش ناخالص",
            align: "end",
            numeric: true,
            cell: (branch) => money.format(branch.subtotal),
          },
          {
            key: "cogs",
            header: "بهای تمام‌شده",
            align: "end",
            numeric: true,
            cell: (branch) => money.format(branch.cogs),
          },
          {
            key: "waste",
            header: "ضایعات",
            align: "end",
            numeric: true,
            cell: (branch) => money.format(branch.wasteCost),
          },
          {
            key: "total",
            header: "فروش خالص",
            align: "end",
            numeric: true,
            cell: (branch) => <span className="font-semibold">{money.format(branch.total)}</span>,
          },
        ]}
        footer={[
          { key: "branch", content: "مجموع کسب‌وکار" },
          {
            key: "orders",
            label: "تعداد سفارش",
            content: toPersianDigits(String(data.consolidated.orderCount)),
            align: "end",
            numeric: true,
          },
          {
            key: "subtotal",
            label: "فروش ناخالص",
            content: money.format(data.consolidated.subtotal),
            align: "end",
            numeric: true,
          },
          {
            key: "cogs",
            label: "بهای تمام‌شده",
            content: money.format(data.consolidated.cogs),
            align: "end",
            numeric: true,
          },
          {
            key: "waste",
            label: "ضایعات",
            content: money.format(data.consolidated.wasteCost),
            align: "end",
            numeric: true,
          },
          {
            key: "total",
            label: "فروش خالص",
            content: money.format(data.consolidated.total),
            align: "end",
            numeric: true,
          },
        ]}
      />
    </SectionCard>
  );
}
