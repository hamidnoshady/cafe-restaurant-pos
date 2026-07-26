"use client";

/**
 * Phase 14 — consolidated numbers across a business's own branches.
 *
 * Not the Phase 9 cross-server comparison (`/dashboard/locations`): this
 * reads `/api/reports/business-overview`, which queries the same reporting
 * views every per-branch report already reads, so these numbers can never
 * disagree with a branch's own reports.
 */
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import { ErrorBox, api, errorMessage } from "../ui";

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

function money(n: number): string {
  return toPersianDigits(formatToman(n));
}

export function BranchOverviewSection() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const res = await api<Overview & { error?: string }>("/api/reports/business-overview");
      if (res.ok) setData(res.data);
      else setError(errorMessage(res.data.error));
      setLoading(false);
    })();
  }, []);

  if (loading) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;
  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!data) return null;

  if (data.branches.length <= 1) {
    return (
      <p className="text-sm text-muted-foreground">
        این کسب‌وکار بیش از یک شعبه ندارد؛ مقایسه وقتی شعبهٔ دوم اضافه شود در دسترس خواهد بود.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr>
            <th className="p-2 text-start">شعبه</th>
            <th className="p-2 text-start">تعداد سفارش</th>
            <th className="p-2 text-start">فروش ناخالص</th>
            <th className="p-2 text-start">بهای تمام‌شده</th>
            <th className="p-2 text-start">ضایعات</th>
            <th className="p-2 text-start">فروش خالص</th>
          </tr>
        </thead>
        <tbody>
          {data.branches.map((branch) => (
            <tr key={branch.locationId} className="border-t">
              <td className="p-2">
                {branch.locationName}
                {!branch.isActive && (
                  <span className="ms-2 rounded bg-muted px-1.5 py-0.5 text-xs">غیرفعال</span>
                )}
              </td>
              <td className="p-2">{toPersianDigits(String(branch.orderCount))}</td>
              <td className="p-2">{money(branch.subtotal)}</td>
              <td className="p-2">{money(branch.cogs)}</td>
              <td className="p-2">{money(branch.wasteCost)}</td>
              <td className="p-2">{money(branch.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t bg-muted/30 font-semibold">
            <td className="p-2">مجموع کسب‌وکار</td>
            <td className="p-2">{toPersianDigits(String(data.consolidated.orderCount))}</td>
            <td className="p-2">{money(data.consolidated.subtotal)}</td>
            <td className="p-2">{money(data.consolidated.cogs)}</td>
            <td className="p-2">{money(data.consolidated.wasteCost)}</td>
            <td className="p-2">{money(data.consolidated.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
