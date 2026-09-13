"use client";

/**
 * Phase 42b — the «گزارش» tab: the low-stock and dead-stock report cards,
 * extracted unchanged from the old one-page /accounting/stock (Phase 27 Wave
 * 8's reports) into the warehouse module's «اقلام و عملیات» group.
 */
import { useCallback, useEffect, useState } from "react";
import { formatPersianNumber } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { api } from "../ui";
import { SectionCard, SectionCardSkeleton } from "../page-chrome";

interface ReportRow {
  itemId: string;
  itemName: string;
  sku: string | null;
  quantity: string;
  reorderPoint?: string;
  level?: "out" | "low";
  lastSoldAt?: string | null;
  valueRial?: number;
}

export function ReportsSection() {
  const money = useMoney();
  const [low, setLow] = useState<ReportRow[] | null>(null);
  const [dead, setDead] = useState<ReportRow[] | null>(null);

  const load = useCallback(() => {
    api<{ low: ReportRow[]; dead: ReportRow[] }>("/api/stock/reports").then(({ ok, data }) => {
      if (ok) {
        setLow(data.low);
        setDead(data.dead);
      }
    });
  }, []);
  useEffect(load, [load]);

  if (low === null || dead === null) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCardSkeleton rows={4} />
        <SectionCardSkeleton rows={4} />
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SectionCard title="کمبود موجودی (زیر نقطهٔ سفارش)" bodyClassName="space-y-3">
        {low.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">چیزی زیر نقطهٔ سفارش نیست.</p>
        ) : (
          <ul className="divide-y divide-border/80 text-sm">
            {low.map((r) => (
              <li key={r.itemId} className="flex items-center justify-between gap-3 py-2">
                <span className="font-medium text-foreground">{r.itemName}</span>
                <span className="text-xs text-amber-700 dark:text-amber-300">
                  {formatPersianNumber(Number(r.quantity))} از {formatPersianNumber(Number(r.reorderPoint ?? "0"))} {r.level === "out" ? "· تمام شده" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard title="کالای راکد (۹۰ روز بدون فروش)" bodyClassName="space-y-3">
        {dead.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">کالای راکدی نیست.</p>
        ) : (
          <ul className="divide-y divide-border/80 text-sm">
            {dead.map((r) => (
              <li key={r.itemId} className="flex items-center justify-between gap-3 py-2">
                <span className="font-medium text-foreground">{r.itemName}</span>
                <span className="text-xs text-muted-foreground">{money.format(r.valueRial ?? 0)}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
