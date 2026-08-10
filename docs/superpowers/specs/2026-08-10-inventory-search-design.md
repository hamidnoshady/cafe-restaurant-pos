# Inventory Item Search — Design

Date: 2026-08-10
Status: Approved (design)

## Problem

The inventory item list (اقلام انبار) renders every item in a long `<ul>` with no way
to find one quickly, and the item pickers in the purchases, waste, and recipes forms are
plain native `<select>` elements over all active items. As a business adds hundreds of
items, both become painful to use. The stock-counts form also carries a half-finished
search (dead `searchQuery` state + unused `useDeferredValue`/`useMemo`/`SearchIcon`
imports) that was never wired up.

## Decision

Client-side search, reusing the existing Persian-aware normalization
(`normalizePosSearchText` in `src/lib/pos-selection.ts`) and the existing
`useDeferredValue` + `useMemo` filter pattern from
`src/app/dashboard/orders/orders-list.tsx`. No API, schema, or migration changes — the
full item list is already delivered to the client by `/api/inventory`.

Search matches **name, SKU, or unit**, all normalized. Rejected alternatives:

- **Server-side search** (`?q=` on the API) — items already ship in full; client-side
  filtering is instant at this scale. YAGNI until item counts reach thousands+.
- **Custom combobox** — nicer typeahead, but the UI kit has no `Command`/`Popover`;
  building keyboard nav, outside-click, and a11y from scratch for 5 pickers is
  disproportionate for an internal POS tool.

## Components

###1. `src/lib/inventory-search.ts` (new)

```ts
export function searchInventoryItems<T extends { name: string; sku: string | null; unit: string }>(
  items: T[],
  query: string,
): T[]
```

- Empty (normalized) query → returns `items` unchanged (fast path).
- Otherwise returns items where `name`, `sku`, or `unit` (normalized) contains the
  normalized query.
- Per-item normalization on each keystroke is acceptable at this scale (hundreds of
  items); `useDeferredValue` smooths it. Pre-caching normalized names is a noted
  optimization, not required now.

Test (`inventory-search.test.ts`): match by name, match by SKU, match by unit, ي/ك and
Arabic/Persian digit variants, empty-query passthrough, no-match → empty.

###2. Items list — `src/app/dashboard/inventory/items-section.tsx`

- Search `<input>` in the section header above the list.
- `useDeferredValue` + `useMemo` filter via `searchInventoryItems`.
- Searches all items (active and inactive are both shown today).
- Distinct empty-result message: «موردی یافت نشد.» vs the existing «قلمی ثبت نشده است.».

###3. Searchable picker — `src/app/dashboard/inventory/inventory-item-picker.tsx` (new)

`InventoryItemPicker({ items, value, onChange, placeholder })` — a filter `<input>`
above the existing native `<select>`; the `<select>` options are filtered via
`searchInventoryItems(items, deferredQuery)`. Callers pass active items only, preserving
today's active-only behavior in the pickers.

Swapped into the 5 existing item selects:
- `waste-section.tsx` (1)
- `recipes-section.tsx` (2 — menu-item recipe line + modifier recipe line)
- `purchases-section.tsx` (shared `lineRows` editor, used by create and edit)

###4. Stock-counts — `src/app/dashboard/inventory/stock-counts-section.tsx`

- Complete the abandoned search: search input filters the counted-items list.
- Remove the dead `searchQuery` state and unused `useDeferredValue`/`useMemo`/`SearchIcon` imports.

## Files

- New: `src/lib/inventory-search.ts`, `src/lib/inventory-search.test.ts`,
  `src/app/dashboard/inventory/inventory-item-picker.tsx`
- Modified: `src/app/dashboard/inventory/items-section.tsx`,
  `src/app/dashboard/inventory/waste-section.tsx`,
  `src/app/dashboard/inventory/recipes-section.tsx`,
  `src/app/dashboard/inventory/purchases-section.tsx`,
  `src/app/dashboard/inventory/stock-counts-section.tsx`

## Verification

- `npx tsc --noEmit`
- `npm test` (covers the new `inventory-search.test.ts`)
- `npm run build`
