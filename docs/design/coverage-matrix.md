# Design-system coverage matrix

An audit of every tenant-facing area against the approved reference screenshots,
with what each screen uses today, how it differs, and its migration priority.

Measured on the branch `arena/01a0b61c-cafe-restaurant-pos`, not estimated.
Counts are files that reference the primitive at all, so they are an upper
bound on adoption per area, not per screen.

> **On the earlier "roughly 40% coverage" estimate:** measured, it is close but
> mislocated. Adoption of `cardClass`/`SectionCard` is high almost everywhere
> (the palette and the card skin were already normalised by an earlier token
> pass). The real gap is **chrome above and inside the card** — page headers,
> section navigation, tables, chips and KPI tiles — where CRM, Growth and
> Website Management were at or near zero, and where Accounting itself was
> inconsistent.

## Summary by app

| App | `.tsx` files | PageHeader | DataTable | FilterChip | KpiCard | Assessment |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Accounting | 48 | 14 | 1 | 4 | 2 | Closest to the references. Tables were the gap: 13 sections still hand-roll `<thead>`. |
| CRM | 29 | 1 | 0 | 0 | 1 | Header comes from the app shell (correct); had its own `StatCard`, now shared. No tables of its own. |
| Growth and Marketing | 23 | 1 | 1 | 0 | 1 | Same shell pattern. Its one table was the worst-drifted in the product — now migrated. |
| Website Management (CMS + WP/Woo) | 39 | 3 | 2 | 0 | 0 | Both managers migrated for tables; no KPI tiles exist yet to share. |
| Settings | 41 | 7 | 0 | 1 | 0 | Matches screenshots 2 and 4 closely already (section nav + stacked cards). |

`PageHeader` counts look low for CRM/Growth/Websites by design: those apps render
one header in their **app shell** (`crm-app-shell.tsx`, the Growth and Websites
equivalents) and their sections render only the body. That is the correct
pattern, not drift — a per-section header would double up.

## What the six screenshots establish, and where each rule now lives

| # | Screenshot | Rules it fixes | Implementation |
| --- | --- | --- | --- |
| 1 | Orders | Page header + search + chip row; order queue; rich empty state (amber icon chip, bold title, muted line) | `PageHeader`, `SearchField`, `FilterChip`, `EmptyState` (`title`/`icon`) |
| 2 | POS | The approved **dense operational variation**: taller targets, denser cards, amber CTA | `FilterChip dense`, `ops-styles.ts`; exempt by path in the primitive lint |
| 3 | Inventory | Section nav, form card, filters, data table, status badges | `SectionNav`, `SectionCard`, `DataTable`, `StatusBadge` |
| 4 | Menu / file import | Section nav, stacked cards, form controls, file upload, info callout | `SectionNav`, `SectionCard`, `Field`/`inputClass`, `InfoBox` |
| 5 | Accounting trial balance | Table density, header wash, numeric columns, `متوازن` status pill, amber eyebrow | `DataTable`/`Th`/`Td`, `StatusBadge dot`, `CardEyebrow` |
| 6 | Business settings | Section nav, stacked form cards, selected money-unit control (amber-100 fill) | `SectionNav`, `SectionCard`, `CurrencyChoice` |

## Conflicts found between the old canon and the new screenshots

| Conflict | Resolution |
| --- | --- |
| `docs/design-system.md` described the table header wash as `bg-stone-50`; the screenshots show the warm token wash, and the code had **three** spellings (`bg-stone-50 text-stone-500 …`, `bg-muted/60`, bare `text-xs text-muted-foreground`) | One spelling, `bg-muted/60 text-muted-foreground`, stated once in `DataTable`. 79 files normalised off hardcoded `stone-*` pairs onto the tokens. |
| Doc said "no baseline anywhere" for design lint, but there was no structural check at all, so duplicated chrome passed | Added `primitive-lint.test.ts`. Its one list (`TABLE_MIGRATION_BACKLOG`) is an explicit, ordered, shrinking work list that cannot grow silently. |
| Three files defined an identical `StatCard`; `KpiRowSkeleton` already shared the *loading* shape | `KpiCard`/`KpiRow` in `page-chrome.tsx`. Two other local tiles were genuinely different and were renamed (`ChequeToneTile`, `OpsKpiTile`) rather than forced onto the shared one. |
| The old reference set has no Orders, Inventory or menu-import image; `pos-sell-screen.png` was the only operational reference | See "Reference images" below. |

## Migrated in this change

| Screen | Was | Now |
| --- | --- | --- |
| Accounting → trial balance | Hand-rolled `<thead>`, hand-rolled status pill, hand-rolled eyebrow | `DataTable`, `StatusBadge dot`, `CardEyebrow` |
| Accounting → AP / AR | Hand-rolled amber view-switcher chips | `FilterChip` |
| Accounting → fiscal periods, reconciliation | Hand-rolled chips | `FilterChip` |
| Accounting → ledger dashboard | Local `StatCard` | `KpiCard` |
| Accounting → cheques | Local `KpiCard` that was actually a toned tile | Renamed `ChequeToneTile`; distinction documented |
| Accounting → orders queue | Hand-rolled chips ×3, two hand-rolled empty states | `FilterChip dense`, `EmptyState` |
| Accounting → inventory warehouses | Hand-rolled `<thead>` | `DataTable` |
| CRM → overview | Local `StatCard` | `KpiCard` |
| Growth → overview | Local `StatCard` | `KpiCard` |
| Growth → customers | Bare `<table>`, **no panel and no header wash at all** | `DataTable` |
| Websites → CMS billing | Hand-rolled `<thead>` | `DataTable` |
| Websites → CMS product sync | Hand-rolled `<thead>` | `DataTable` |
| Settings → print template designer | Hand-rolled multi-select chips | `FilterChip` |
| Dashboard → media manager | Hand-rolled chips | `FilterChip` |
| 79 files across all apps | Hardcoded `stone-*` light/dark pairs | Theme tokens that flip automatically |

## Remaining work — ordered checklist

Every item is enforced by `TABLE_MIGRATION_BACKLOG` in
`src/app/dashboard/primitive-lint.test.ts`: the rule is live, these files are
named exceptions, and removing an entry is how the work is marked done. **A new
hand-rolled table in any other file fails the check today.**

### Batch A — Accounting ledger tables (13 files, highest impact)

- [ ] `(app)/accounting/entries-section.tsx` — journal register
- [ ] `(app)/accounting/chart-of-accounts-section.tsx`
- [ ] `(app)/accounting/expense-section.tsx`
- [ ] `(app)/accounting/receipts-payments-section.tsx`
- [ ] `(app)/accounting/ar-section.tsx` and `ar-statement-panel.tsx`
- [ ] `(app)/accounting/ap-section.tsx` and `ap-statement-panel.tsx`
- [ ] `(app)/accounting/account-statement-panel.tsx`
- [ ] `(app)/accounting/reconciliation-section.tsx`
- [ ] `(app)/accounting/fiscal-periods-section.tsx`
- [ ] `(app)/accounting/fixed-assets-section.tsx`
- [ ] `(app)/accounting/installments-section.tsx`

### Batch B — Reports (4 files, one shared component)

- [ ] `dashboard/reports/report-table.tsx` — migrate this **first**; the other
      three are its consumers and may need no change afterwards
- [ ] `dashboard/reports/ledger-report-view.tsx`
- [ ] `dashboard/reports/drill-down-panel.tsx`
- [ ] `dashboard/reports/shift-orders-section.tsx`

### Batch C — Inventory, stock and products (7 remaining of 8)

- [ ] `dashboard/inventory/documents-section.tsx`
- [ ] `dashboard/inventory/purchases-section.tsx`
- [ ] `dashboard/inventory/stock-section.tsx`
- [ ] `dashboard/stock/documents-section.tsx`
- [ ] `dashboard/stock/stock-levels-section.tsx`
- [x] `dashboard/stock/warehouses-section.tsx` — done in this PR
- [ ] `dashboard/products/price-lists-section.tsx`
- [ ] `dashboard/products/products-list-section.tsx`

### Batch D — Long tail (4 files)

- [ ] `dashboard/parties/parties-section.tsx`
- [ ] `dashboard/locations/locations-manager.tsx`
- [ ] `dashboard/backup/backup-manager.tsx`
- [ ] `setup/accounts/page.tsx`

### Batch E — Not yet covered by any automated rule

- [x] **Search fields**: the four files whose markup matched `SearchField`
      exactly were migrated in this PR (inventory + stock `warehouses-section`,
      `products-list-section`, `price-lists-section`) and their now-dead
      `SearchIcon` imports removed. Six remain, each with a real difference
      (an inline clear button at a different offset, a combobox, a nav filter);
      they need `SearchField` to grow a prop rather than a copy-paste, so they
      are deliberately left until that prop is designed. A lint rule is worth
      adding once they are all migrated.
- [ ] **Mobile card fallbacks**: each migrated table keeps a bespoke `lg:hidden`
      card list. These are consistent in palette but not shared; a
      `DataTableMobileList` would remove ~15 near-duplicates.
- [ ] **Section navigation in CRM / Growth / Websites**: these apps use sidebar
      doors rather than in-page `SectionNav`. This matches their IA and is
      *not* drift, but it should be stated in the design doc so a future agent
      does not "fix" it into inconsistency.
