"use client";

/**
 * The reports section's one table.
 *
 * Every report screen here had grown its own copy of the same thing: a
 * `<table>` for `sm:` and up, a duplicate `sm:hidden` list of `<article>`
 * cards below it, and a third spelling of the empty row — in
 * `chart-preview.tsx`, `branch-overview-section.tsx`, `ledger-report-view.tsx`
 * and again in each of the per-trade report tabs. Four copies of a table is
 * four places for a column to fall out of alignment with its header, and the
 * mobile halves had already drifted apart (one used `bg-muted` cards, another
 * dashed borders, a third nothing at all).
 *
 * So the table is declared once, as data: a column says how to render a cell
 * and how it should align, and this renders the desktop grid and the phone
 * cards from that single declaration. A column can never appear in one and not
 * the other.
 *
 * The desktop table is deliberately *not* wrapped in its own card — it is meant
 * to sit inside a `flush` `SectionCard`, which is what gives it the section
 * heading, the divider under it and the card's own edges (docs/design-system.md
 * §Tables).
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ReportTableColumn<Row> {
  key: string;
  header: ReactNode;
  /** The cell's content. Return a string/number for text, or a node for chips and buttons. */
  cell: (row: Row) => ReactNode;
  /**
   * `end` for money and counts (a number column reads right-aligned even in an
   * RTL table, which is why this says `end`/`start` and never left/right).
   */
  align?: "start" | "end";
  /** Rendered in a lighter weight — codes, dates, secondary detail. */
  muted?: boolean;
  /** Numbers get tabular figures so columns line up digit for digit. */
  numeric?: boolean;
  /** Kept out of the phone cards: a column that only makes sense beside others. */
  desktopOnly?: boolean;
}

export interface ReportTableFooterCell {
  key: string;
  content: ReactNode;
  align?: "start" | "end";
  numeric?: boolean;
  /**
   * What to call this figure on a phone, where the footer is a summary card
   * with no column headers above it to inherit a name from. The first cell is
   * the row's own label and needs none.
   */
  label?: string;
}

interface ReportTableProps<Row> {
  columns: readonly ReportTableColumn<Row>[];
  rows: readonly Row[];
  /** Stable key per row; falls back to the row index. */
  rowKey?: (row: Row, index: number) => string;
  /** Names the table for a screen reader. */
  caption: string;
  /** Shown in place of the rows when there are none. */
  empty?: ReactNode;
  /** A totals row — rendered as a `<tfoot>` on desktop and a summary card on a phone. */
  footer?: readonly ReportTableFooterCell[];
  /** The card's title on a phone, when the first column is not self-explanatory. */
  cardTitle?: (row: Row) => ReactNode;
  className?: string;
}

const EMPTY_TEXT = "داده‌ای یافت نشد.";

export function ReportTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  empty = EMPTY_TEXT,
  footer,
  cardTitle,
  className,
}: ReportTableProps<Row>) {
  const cardColumns = columns.filter((column) => !column.desktopOnly);

  return (
    <div className={cn("min-w-0", className)}>
      {/* Desktop: one scrollable grid. */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="min-w-full text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-muted/60 text-muted-foreground dark:bg-muted">
            <tr className="border-b border-border">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    "px-4 py-3 text-xs font-medium sm:text-sm",
                    column.align === "end" ? "text-end" : "text-start",
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={rowKey?.(row, index) ?? index}
                className="border-b border-border transition-colors last:border-b-0 hover:bg-muted/60 dark:hover:bg-muted/60"
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      "px-4 py-3",
                      column.align === "end" ? "text-end" : "text-start",
                      column.numeric && "tabular-nums",
                      column.muted ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {empty}
                </td>
              </tr>
            ) : null}
          </tbody>
          {footer && rows.length > 0 ? (
            <tfoot className="bg-muted/60 dark:bg-muted">
              <tr className="border-t border-border font-semibold text-foreground">
                {footer.map((cell) => (
                  <td
                    key={cell.key}
                    className={cn(
                      "px-4 py-3",
                      cell.align === "end" ? "text-end" : "text-start",
                      cell.numeric && "tabular-nums",
                    )}
                  >
                    {cell.content}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      {/* Phone: the same columns as a labelled card, so nothing is hidden by width alone. */}
      <ul className="divide-y divide-border sm:hidden">
        {rows.map((row, index) => {
          // The first column is always this card's heading — either an
          // explicit cardTitle or the column's own cell — so it never also
          // appears as the first body row; rendering it twice was the old
          // `title ? cardColumns : …slice(1)` branch's mistake.
          const title = cardTitle?.(row);
          const bodyColumns = cardColumns.slice(1);
          return (
            <li key={rowKey?.(row, index) ?? index} className="px-4 py-4">
              <p className="min-w-0 break-words font-semibold text-foreground">
                {title ?? cardColumns[0]?.cell(row)}
              </p>
              <dl className="mt-2 grid gap-1.5">
                {bodyColumns.map((column) => (
                  <div key={column.key} className="flex items-baseline justify-between gap-3">
                    <dt className="shrink-0 text-xs text-muted-foreground">{column.header}</dt>
                    <dd
                      className={cn(
                        "min-w-0 break-words text-end text-sm text-foreground",
                        column.numeric && "tabular-nums",
                      )}
                    >
                      {column.cell(row)}
                    </dd>
                  </div>
                ))}
              </dl>
            </li>
          );
        })}
        {rows.length === 0 ? (
          <li className="px-4 py-10 text-center text-sm text-muted-foreground">{empty}</li>
        ) : null}
        {footer && rows.length > 0 ? (
          <li className="bg-muted/60 px-4 py-3 dark:bg-muted">
            <p className="font-semibold text-foreground">{footer[0]?.content}</p>
            <dl className="mt-2 grid gap-1.5">
              {footer.slice(1).map((cell) => (
                <div key={cell.key} className="flex items-baseline justify-between gap-3">
                  <dt className="text-xs text-muted-foreground">{cell.label ?? cell.key}</dt>
                  <dd className={cn("text-sm font-semibold text-foreground", cell.numeric && "tabular-nums")}>
                    {cell.content}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
