"use client";

import { BarChart, LineChart, NumberCard, PieChart, type ChartDatum } from "../charts";
import { toPersianDigits } from "@/lib/digits";
import type { ChartType } from "./report-ui";

export function ChartPreview({ chartType, data, label }: { chartType: ChartType; data: ChartDatum[]; label: string }) {
  if (chartType === "number") {
    const total = data.reduce((s, d) => s + d.value, 0);
    return <NumberCard label={label} value={toPersianDigits(Math.round(total).toLocaleString("en-US"))} />;
  }
  if (chartType === "line") return <LineChart data={data} height={260} />;
  if (chartType === "pie") return <PieChart data={data} height={260} />;
  return <BarChart data={data} height={260} />;
}

export function DataTable({ columns, data }: { columns: [string, string]; data: ChartDatum[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="py-2 pe-3 text-start">{columns[0]}</th>
            <th className="py-2 text-start">{columns[1]}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={i} className="border-b border-border">
              <td className="py-2 pe-3">{d.label}</td>
              <td className="py-2 tabular-nums">{toPersianDigits(Math.round(d.value).toLocaleString("en-US"))}</td>
            </tr>
          ))}
          {data.length === 0 ? (
            <tr>
              <td colSpan={2} className="py-4 text-center text-muted-foreground">
                داده‌ای یافت نشد.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
