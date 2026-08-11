# Inventory Item Search — Design

Date: 2026-08-10
Status: Approved (design)

## Problem

The inventory item list (اقلام انبار) and the physical stock counts list render all items with no search capability, making them painful to use as the catalog grows. The form pickers (waste, recipes, purchases) use a `SearchableSelect` combobox that only searches on the item name (`label`), leaving users unable to find items by SKU or unit.

## Decision

Client-side search, upgrading the existing `normalizePosSearchText` and `SearchableSelect` components. No API or schema changes.

Search matches **name, SKU, or unit**, all normalized.

## Components

### 1. `SearchableSelect` Upgrade — `src/components/ui/searchable-select.tsx`

- Add an optional `searchString` property to the `SelectOption` interface.
- Update its internal filter: if `option.searchString` is provided, filter against `normalizePosSearchText(option.searchString)`; otherwise fallback to `normalizePosSearchText(option.label)`.
- Replace its duplicated internal `normalize` function with the shared `normalizePosSearchText` from `@/lib/pos-selection`.
- Update the item pickers in `waste-section.tsx`, `recipes-section.tsx`, and `purchases-section.tsx` to provide `searchString: [i.name, i.sku, i.unit].filter(Boolean).join(" ")` in their options map.

### 2. Shared Filter Function — `src/lib/inventory-search.ts` (new)

A new shared helper for filtering the `InventoryItem[]` lists in the items and stock-counts sections.
```ts
// src/lib/inventory-search.ts
import { normalizePosSearchText } from "@/lib/pos-selection";
import type { InventoryItem } from "@/app/dashboard/inventory/inventory-manager";

export function searchInventoryItems(items: InventoryItem[], query: string): InventoryItem[] {
  const normalizedQuery = normalizePosSearchText(query);
  if (!normalizedQuery) return items;

  return items.filter((item) => {
    const searchable = [item.name, item.sku, item.unit].filter(Boolean).join(" ");
    return normalizePosSearchText(searchable).includes(normalizedQuery);
  });
}
```
- A corresponding `inventory-search.test.ts` will verify matching on name, SKU, and unit, including Persian character variants.

### 3. Items list — `src/app/dashboard/inventory/items-section.tsx`

- Add a search `<input>` in the section header above the list.
- Use `useDeferredValue` + `useMemo` to filter the items via `searchInventoryItems`.
- Searches all items (active and inactive).
- Add a distinct empty-result message: «موردی یافت نشد.»

### 4. Stock-counts — `src/app/dashboard/inventory/stock-counts-section.tsx`

- Wire up the half-finished search using the new `searchInventoryItems` helper.
- Use the same `useDeferredValue` + `useMemo` filter as the items list.

## Files

- New: `src/lib/inventory-search.ts`
- New: `src/lib/inventory-search.test.ts`
- Modified: `src/components/ui/searchable-select.tsx`
- Modified: `src/app/dashboard/inventory/items-section.tsx`
- Modified: `src/app/dashboard/inventory/stock-counts-section.tsx`
- Modified: `src/app/dashboard/inventory/waste-section.tsx`
- Modified: `src/app/dashboard/inventory/recipes-section.tsx`
- Modified: `src/app/dashboard/inventory/purchases-section.tsx`

## Verification

- `npx tsc --noEmit`
- `npm test`
- `npm run build`
