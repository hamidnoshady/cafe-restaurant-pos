"use client";

import {
  BarChart,
  LineChart,
  NumberCard,
  PieChart,
  type ChartDatum,
} from "../charts";
import { toPersianDigits } from "@/lib/digits";
import type { ChartType } from "./report-ui";

export function ChartPreview({
  chartType,
  data,
  label,
}: {
  chartType: ChartType;
  data: ChartDatum[];
  label: string;
}) {
  if (chartType === "number") {
    const total = data.reduce((sum, datum) => sum + datum.value, 0);
    return (
      <NumberCard
        label={label}
        value={toPersianDigits(Math.round(total).toLocaleString("en-US"))}
      />
    );
  }
  if (chartType === "line") return <LineChart data={data} height={260} />;
  if (chartType === "pie") return <PieChart data={data} height={260} />;
  return <BarChart data={data} height={260} />;
}

export function DataTable({
  columns,
  data,
}: {
  columns: [string, string];
  data: ChartDatum[];
}) {
  return (
    <section aria-label="داده‌های گزارش">
      <div className="hidden overflow-hidden rounded-xl border border-stone-200/80 bg-card sm:block">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <caption className="sr-only">داده‌های گزارش</caption>
            <thead className="bg-stone-50 text-stone-500">
              <tr className="border-b border-stone-200/80">
                <th
                  scope="col"
                  className="px-4 py-3 text-start text-xs font-semibold"
                >
                  {columns[0]}
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-start text-xs font-semibold"
                >
                  {columns[1]}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((datum, index) => (
                <tr
                  key={index}
                  className="border-b border-stone-100 last:border-b-0"
                >
                  <td className="px-4 py-3.5 font-medium text-stone-950">
                    {datum.label}
                  </td>
                  <td className="px-4 py-3.5 tabular-nums text-stone-950">
                    {toPersianDigits(
                      Math.round(datum.value).toLocaleString("en-US"),
                    )}
                  </td>
                </tr>
              ))}
              {data.length === 0 ? (
                <tr>
                  <td
                    colSpan={2}
                    className="px-4 py-10 text-center text-sm text-stone-500"
                  >
                    داده‌ای یافت نشد.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <ul className="space-y-2 sm:hidden">
        {data.map((datum, index) => (
          <li
            key={index}
            className="rounded-xl border border-stone-200/80 bg-stone-50 p-4"
          >
            <dl className="space-y-2">
              <div>
                <dt className="text-xs font-medium text-stone-500">
                  {columns[0]}
                </dt>
                <dd className="mt-1 break-words font-semibold text-stone-950">
                  {datum.label}
                </dd>
              </div>
              <div className="border-t border-stone-100 pt-2">
                <dt className="text-xs font-medium text-stone-500">
                  {columns[1]}
                </dt>
                <dd className="mt-1 tabular-nums font-bold text-stone-950">
                  {toPersianDigits(
                    Math.round(datum.value).toLocaleString("en-US"),
                  )}
                </dd>
              </div>
            </dl>
          </li>
        ))}
        {data.length === 0 ? (
          <li className="rounded-xl border border-dashed border-stone-200/80 bg-stone-50 px-4 py-10 text-center text-sm text-stone-500">
            داده‌ای یافت نشد.
          </li>
        ) : null}
      </ul>
    </section>
  );
}
