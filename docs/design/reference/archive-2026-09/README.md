# Archived reference screenshots (pre-2026-09)

These images were the approved visual reference **before** the 2026-09-18
screenshot set replaced them. They are kept, not deleted, for two reasons:

1. Several show a screen or a state the new set does not cover — the
   `SearchableSelect` popover with its teal focus ring
   (`ledger-expense-combobox.png`), the dashboard overview's KPI cards and
   amber bar chart (`dashboard-overview.png`), the reservations empty states
   (`reservations.png`).
2. They document what the product looked like when the current token palette
   was adopted, which is useful when reading older commits.

**They are historical, not normative.** Where one of these images disagrees with
[`docs/design-system.md`](../../../design-system.md), the document wins. The
known differences are:

- **Table headers.** These images show the header wash spelled `bg-stone-50`
  with `text-stone-500` labels. The approved spelling is now the theme token
  pair (`bg-muted/60` / `text-muted-foreground`), stated once in
  `src/app/dashboard/data-table.tsx`, because the hardcoded version did not flip
  in dark mode and had drifted into three variants.
- **Ad-hoc KPI tiles.** `dashboard-overview.png` predates the shared `KpiCard`;
  the tiles it shows were three separate local `StatCard` definitions.

Do not use these images as the target when building or restyling a screen, and
do not cite them as evidence that a screen is correct.
