"use client";

import {
  BarChart,
  LineChart,
  NumberCard,
  PieChart,
  type ChartDatum,
} from "../charts";
import { toPersianDigits } from "@/lib/digits";
import { ReportTable } from "./report-table";
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

/**
 * A built report's rows: one dimension, one measure.
 *
 * This was a hand-rolled table plus a hand-rolled card list — the same pair
 * `ReportTable` now owns — so it is a thin declaration over that instead. It
 * expects to sit inside a `flush` SectionCard, which supplies the card edges
 * this used to draw for itself.
 */
export function DataTable({
  columns,
  data,
}: {
  columns: [string, string];
  data: ChartDatum[];
}) {
  return (
    <ReportTable
      caption="داده‌های گزارش"
      rows={data}
      rowKey={(_, index) => String(index)}
      cardTitle={(datum) => datum.label}
      columns={[
        { key: "label", header: columns[0], cell: (datum) => datum.label },
        {
          key: "value",
          header: columns[1],
          align: "end",
          numeric: true,
          cell: (datum) => toPersianDigits(Math.round(datum.value).toLocaleString("en-US")),
        },
      ]}
    />
  );
}
