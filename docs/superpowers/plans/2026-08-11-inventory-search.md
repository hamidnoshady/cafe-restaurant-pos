# Inventory Item Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Persian-aware, client-side search over inventory items (name/SKU/unit) in the items list, the stock-counts form, and the item pickers in the waste / recipes / purchases forms.

**Architecture:** Search is purely client-side — the full item list already arrives via `/api/inventory`. A shared pure function `searchInventoryItems` filters item arrays; the existing `SearchableSelect` combobox (used by the form pickers) learns an optional `searchString` per option and reuses the shared `normalizePosSearchText` instead of its own copy of the normalizer.

**Tech Stack:** Next.js 15 App Router (TypeScript), React 19, `radix-ui` Popover, lucide-react icons, vitest for unit tests.

## Global Constraints

- Search must match **name, SKU, or unit**, Persian-normalized (see spec §Decision).
- No API, schema, or migration changes. No new dependencies.
- `src/lib/*.ts` additions get a `*.test.ts` beside them (repo convention; mirrors `src/lib/orders.test.ts`).
- New `src/lib` files are framework-free: no imports from `src/app/**`.
- Every task ends green under `npx tsc --noEmit` and `npm test` (for the lib task). Full local gate before the final PR: `npx tsc --noEmit`, `npm test`, `npm run build`.
- `normalizePosSearchText` lives in `src/lib/pos-selection.ts` and is already exported — reuse it, do not duplicate its logic.
- RTL/Persian copy stays intact; only additive UI (search inputs, empty-state strings) is introduced.

---

### Task 1: Shared filter function `searchInventoryItems` + tests

**Files:**
- Create: `src/lib/inventory-search.ts`
- Create: `src/lib/inventory-search.test.ts`

**Interfaces:**
- Consumes: `normalizePosSearchText(value: string): string` from `@/lib/pos-selection`.
- Produces: `searchInventoryItems<T extends SearchableInventoryItem>(items: T[], query: string): T[]` and the `SearchableInventoryItem` type (structural `{ name: string; sku: string | null; unit: string }`). Tasks 5 and 6 consume this with the app's `InventoryItem[]` (which satisfies the structural type).

- [ ] **Step 1: Write the failing test**

Create `src/lib/inventory-search.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { searchInventoryItems } from "./inventory-search";

const items = [
  { id: "1", name: "قهوه", sku: "COF-001", unit: "g" },
  { id: "2", name: "شیر", sku: null, unit: "ml" },
  { id: "3", name: "شکر", sku: "SUG-002", unit: "kg" },
  { id: "4", name: "يخ", sku: "ICE-123", unit: "kg" },
];

describe("searchInventoryItems", () => {
  it("returns items unchanged for an empty query", () => {
    expect(searchInventoryItems(items, "")).toEqual(items);
    expect(searchInventoryItems(items, "   ")).toEqual(items);
  });

  it("matches by name", () => {
    expect(searchInventoryItems(items, "قهوه").map((i) => i.id)).toEqual(["1"]);
  });

  it("matches by sku, case-insensitively", () => {
    expect(searchInventoryItems(items, "cof").map((i) => i.id)).toEqual(["1"]);
  });

  it("matches by unit", () => {
    expect(searchInventoryItems(items, "kg").map((i) => i.id)).toEqual(["3", "4"]);
  });

  it("unifies Arabic ي with Persian ی", () => {
    expect(searchInventoryItems(items, "یخ").map((i) => i.id)).toEqual(["4"]);
  });

  it("unifies Arabic/Persian digits", () => {
    expect(searchInventoryItems(items, "۱۲۳").map((i) => i.id)).toEqual(["4"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(searchInventoryItems(items, "چای")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/lib/inventory-search.test.ts`
Expected: FAIL — `./inventory-search` module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/inventory-search.ts`:

```ts
import { normalizePosSearchText } from "./pos-selection";

export interface SearchableInventoryItem {
  name: string;
  sku: string | null;
  unit: string;
}

export function searchInventoryItems<T extends SearchableInventoryItem>(
  items: T[],
  query: string,
): T[] {
  const normalizedQuery = normalizePosSearchText(query);
  if (!normalizedQuery) return items;
  return items.filter((item) => {
    const searchable = [item.name, item.sku ?? "", item.unit]
      .filter(Boolean)
      .join(" ");
    return normalizePosSearchText(searchable).includes(normalizedQuery);
  });
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/lib/inventory-search.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory-search.ts src/lib/inventory-search.test.ts
git commit -m "feat: shared inventory item search helper"
```

---

### Task 2: `SearchableSelect` learns `searchString` and shared normalization

**Files:**
- Modify: `src/components/ui/searchable-select.tsx` (the `SelectOption` interface ~line 21, the local `normalize` fn ~line 38, the `filtered` memo ~line 65)

**Interfaces:**
- Consumes: `normalizePosSearchText` from `@/lib/pos-selection`.
- Produces: `SelectOption` gains `searchString?: string`. When present, filtering searches that string; otherwise it falls back to `label`. Backward compatible — every existing caller keeps working untouched. Tasks 3 and 4 pass `searchString` for inventory-item options.

- [ ] **Step 1: Add `searchString` to the option type**

In `src/components/ui/searchable-select.tsx`, change:

```ts
export interface SelectOption {
  value: string;
  label: string;
}
```

to:

```ts
export interface SelectOption {
  value: string;
  label: string;
  /** Optional text searched instead of `label` when filtering (e.g. name + SKU + unit). */
  searchString?: string;
}
```

- [ ] **Step 2: Reuse the shared normalizer**

Add the import at the top of `src/components/ui/searchable-select.tsx`:

```ts
import { normalizePosSearchText } from "@/lib/pos-selection";
```

Delete the local `normalize` function (lines ~38–47) entirely.

- [ ] **Step 3: Filter on `searchString` when provided**

Change the `filtered` memo to:

```tsx
  const filtered = React.useMemo(() => {
    const q = normalizePosSearchText(query);
    return q
      ? options.filter((o) =>
          normalizePosSearchText(o.searchString ?? o.label).includes(q),
        )
      : options;
  }, [options, query]);
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/searchable-select.tsx
git commit -m "feat: searchable select filters on optional searchString via shared normalize"
```

---

### Task 3: Pass `searchString` in the waste and recipes item pickers

**Files:**
- Modify: `src/app/dashboard/inventory/waste-section.tsx` (item `SearchableSelect` options ~line 76)
- Modify: `src/app/dashboard/inventory/recipes-section.tsx` (two item `SearchableSelect` options blocks — menu-item recipe ~line 120, modifier recipe ~line 233)

**Interfaces:**
- Consumes: `SearchableSelect`'s `searchString` option field (Task 2).
- Produces: nothing new for other tasks.

- [ ] **Step 1: Waste section item picker**

In `src/app/dashboard/inventory/waste-section.tsx`, replace:

```tsx
                ...activeItems.map((i) => ({ value: i.id, label: `${i.name} (${i.unit})` })),
```

with:

```tsx
                ...activeItems.map((i) => ({
                  value: i.id,
                  label: `${i.name} (${i.unit})`,
                  searchString: [i.name, i.sku, i.unit].filter(Boolean).join(" "),
                })),
```

- [ ] **Step 2: Recipes — menu-item recipe line picker**

In `src/app/dashboard/inventory/recipes-section.tsx`, find the item `SearchableSelect` inside `MenuItemRecipeCard` (options include `...activeItems.map((i) => ({ value: i.id, label: `${i.name} (${i.unit})` }))`) and apply the same `searchString` addition as Step 1.

- [ ] **Step 3: Recipes — modifier recipe line picker**

In `src/app/dashboard/inventory/recipes-section.tsx`, find the item `SearchableSelect` inside `ModifierRecipeCard` (same options shape) and apply the same `searchString` addition.

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/inventory/waste-section.tsx src/app/dashboard/inventory/recipes-section.tsx
git commit -m "feat: search waste and recipe item pickers by name, sku, and unit"
```

---

### Task 4: Convert the purchases item picker to `SearchableSelect`

> Note: `src/app/dashboard/inventory/purchases-section.tsx` currently has unrelated uncommitted work (purchase-line editing). Before editing, run `git status` and `git diff src/app/dashboard/inventory/purchases-section.tsx` to confirm the working tree is in the expected shape; the change below targets only the item `<select>` inside the `lineRows` helper.

**Files:**
- Modify: `src/app/dashboard/inventory/purchases-section.tsx` (the item `<select>` in `lineRows`, ~lines 280–291; add the import near the other imports)

**Interfaces:**
- Consumes: `SearchableSelect` (Task 2).
- Produces: nothing for other tasks.

- [ ] **Step 1: Add the import**

In `src/app/dashboard/inventory/purchases-section.tsx`, add near the other imports:

```ts
import { SearchableSelect } from "@/components/ui/searchable-select";
```

- [ ] **Step 2: Replace the native item select**

In the `lineRows` helper, replace:

```tsx
          <Field label="قلم انبار">
            <select
              className={inputClass}
              value={line.inventoryItemId}
              onChange={(e) => onChange(i, { inventoryItemId: e.target.value })}
            >
              <option value="">قلم انبار را انتخاب کنید…</option>
              {activeItems.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name}
                </option>
              ))}
            </select>
          </Field>
```

with:

```tsx
          <Field label="قلم انبار">
            <SearchableSelect
              value={line.inventoryItemId}
              onChange={(value) => onChange(i, { inventoryItemId: value })}
              options={[
                { value: "", label: "قلم انبار را انتخاب کنید…" },
                ...activeItems.map((it) => ({
                  value: it.id,
                  label: it.name,
                  searchString: [it.name, it.sku, it.unit].filter(Boolean).join(" "),
                })),
              ]}
            />
          </Field>
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors. (`inputClass` may become unused in this file only if nothing else uses it — if so, remove its import; otherwise leave it.)

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/inventory/purchases-section.tsx
git commit -m "feat: search purchase line item picker by name, sku, and unit"
```

---

### Task 5: Search box in the items list

**Files:**
- Modify: `src/app/dashboard/inventory/items-section.tsx` (imports ~lines 1–8, `ItemsSection` body ~lines 23–83)

**Interfaces:**
- Consumes: `searchInventoryItems` from `@/lib/inventory-search` (Task 1).
- Produces: nothing for other tasks.

- [ ] **Step 1: Add imports and filter state**

At the top of `src/app/dashboard/inventory/items-section.tsx`, change the React import to:

```tsx
import { useDeferredValue, useMemo, useState } from "react";
```

Add, near the other imports:

```tsx
import { SearchIcon } from "lucide-react";
import { searchInventoryItems } from "@/lib/inventory-search";
```

- [ ] **Step 2: Add the query state and derived list**

Inside `ItemsSection`, after the existing `useState` calls (e.g. after the `purchaseFactor` state), add:

```tsx
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const visibleItems = useMemo(
    () => searchInventoryItems(items, deferredQuery),
    [items, deferredQuery],
  );
```

- [ ] **Step 3: Render the search input**

Inside the section header div (the one with `id="inventory-items-heading"`), after the `<p>` description, add:

```tsx
          <div className="relative mt-3">
            <SearchIcon className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              className={`${inventoryInputClass} ps-9`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="جستجوی قلم (نام، کد، واحد)…"
              aria-label="جستجوی قلم انبار"
            />
          </div>
```

- [ ] **Step 4: Filter the list and add the empty-result state**

In the `<ul>`, change `items.map` to `visibleItems.map`, and replace the empty-state `{items.length === 0 ? … : null}` block with:

```tsx
          {items.length === 0 ? (
            <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">
              قلمی ثبت نشده است.
            </li>
          ) : visibleItems.length === 0 ? (
            <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">
              موردی یافت نشد.
            </li>
          ) : null}
```

- [ ] **Step 5: Verify it compiles and tests stay green**

Run: `npx tsc --noEmit`
Run: `npx vitest run src/lib/inventory-search.test.ts`
Expected: no errors; tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/inventory/items-section.tsx
git commit -m "feat: search inventory items list by name, sku, and unit"
```

---

### Task 6: Wire up the stock-counts search

**Files:**
- Modify: `src/app/dashboard/inventory/stock-counts-section.tsx` (the form body — search input + filtered list, ~lines 62–80)

**Interfaces:**
- Consumes: `searchInventoryItems` from `@/lib/inventory-search` (Task 1).
- Produces: nothing for other tasks.

> The file already imports `useDeferredValue`, `useMemo`, and `SearchIcon` and declares a dead `searchQuery` state (a previously abandoned half-finish). This task completes it.

- [ ] **Step 1: Add the import**

In `src/app/dashboard/inventory/stock-counts-section.tsx`, add near the other imports:

```ts
import { searchInventoryItems } from "@/lib/inventory-search";
```

- [ ] **Step 2: Derive the filtered list**

After the `const activeItems = items.filter((i) => i.is_active);` line, add:

```tsx
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const visibleItems = useMemo(
    () => searchInventoryItems(activeItems, deferredSearchQuery),
    [activeItems, deferredSearchQuery],
  );
```

- [ ] **Step 3: Render the search input**

Inside the first `<section>` (the physical-count form), between the `<p>` description and the `<form>`, add:

```tsx
        <div className="relative mb-3">
          <SearchIcon className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            className={`${inputClass} ps-9`}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="جستجوی قلم (نام، کد، واحد)…"
            aria-label="جستجوی قلم برای شمارش"
          />
        </div>
```

- [ ] **Step 4: Filter the counted-items list**

In the `<ul className="divide-y divide-border rounded-lg border border-border">`, change `activeItems.map` to `visibleItems.map`, and add an empty state after the map:

```tsx
            {visibleItems.length === 0 ? (
              <li className="p-3 text-sm text-muted-foreground">
                موردی یافت نشد.
              </li>
            ) : null}
```

Leave the `submit` handler untouched — it already builds lines from `activeItems` filtered by which items have a count entered, so hiding items via search never drops an entered count.

- [ ] **Step 5: Verify it compiles and tests stay green**

Run: `npx tsc --noEmit`
Run: `npx vitest run src/lib/inventory-search.test.ts`
Expected: no errors; tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/inventory/stock-counts-section.tsx
git commit -m "feat: complete stock-count item search"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run the full local gate**

Run: `npx tsc --noEmit`
Run: `npm test`
Run: `npm run build`
Expected: all green.

- [ ] **Step 2: Re-check the spec coverage**

Every section of `docs/superpowers/specs/2026-08-10-inventory-search-design.md` is implemented:
- `SearchableSelect` upgrade → Task 2
- shared `searchInventoryItems` + test → Task 1
- waste/recipes pickers search name+SKU+unit → Task 3
- purchases picker searchable → Task 4
- items-list search with «موردی یافت نشد.» → Task 5
- stock-counts search → Task 6

- [ ] **Step 3: Commit any remaining stray changes (if the working tree is dirty from Task 4's untouched work, leave it)**

```bash
git status
```
Expected: clean tree aside from any pre-existing uncommitted work that predates this feature.
