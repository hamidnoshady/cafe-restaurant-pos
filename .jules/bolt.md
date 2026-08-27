## 2024-08-07 - Add useDeferredValue to search queries
**Learning:** Typing in search fields can be slow if it immediately triggers complex filtering operations, causing the UI to become unresponsive.
**Action:** Apply `useDeferredValue` for fast inputs while deferring slow filtering tasks to improve rendering performance.
## 2023-10-27 - [Over-memoization]
 **Learning:** [Do not memoize primitives just because they are going into another useMemo. It is a React anti-pattern to memoize simple primitive types if the only purpose is keeping them stable for a subsequent hook, because primitives compare by value anyway.]
 **Action:** [Only useMemo for expensive derived state objects and arrays, not integers or simple strings.]
## 2026-08-14 - Deferred Search Input Filtering
**Learning:** Typing in search fields can be slow if it immediately triggers complex filtering operations, causing the UI to become unresponsive.
**Action:** Apply `useDeferredValue` for fast inputs while deferring slow filtering tasks to improve rendering performance.
## 2024-03-24 - Expensive Regex String Normalizations in Hot Loops
**Learning:** In the POS screen, string normalization (handling Arabic/Persian digits and diacritics via multiple `.replace()` with Regexes) is called inside `searchPosMenuItems`. Since this search runs over hundreds of items on every keystroke, the string allocations and regex executions become a noticeable performance bottleneck, causing typing lag.
**Action:** Memoize pure string manipulation functions (like `normalizePosSearchText`) using a simple `Map` with a max-size eviction strategy when they are used inside hot loops like search filters.
## 2025-01-20 - Expensive Date Parsing in Hot Loops
**Learning:** In the kitchen dashboard screen, `tickets` array grouping by `order_id` and string to date parsing through `new Date(item.sent_to_kitchen_at).getTime()` for calculating the ticket's `earliestSentAt` was tied to a `now` value updating every 15 seconds.
**Action:** Separate static data operations (like grouping, filtering, or date parsing) into a distinct `useMemo` that dependes solely on the original items array, so they do not get recalculated on every tick.
## 2024-05-18 - Repeated O(n) filtering inside useMemo
**Learning:** Avoid executing O(n) algorithms (like `Array.filter` or `new Map(Array.map)`) inside a `useMemo` that also depends on frequently changing states (like a `deferredSearchQuery` on keystrokes).
**Action:** Extract the static O(n) array transformations into their own, independent `useMemo` hooks that only re-compute when the base source data changes, reusing these pre-computed results in downstream search hooks.
## 2024-08-19 - Repeated String Normalization in Hot loops
**Learning:** `normalizePosSearchText` performs expensive regex and replacements. Calling it inside `useMemo` on hundreds of items per keystroke during filtering can slow down rendering and block the main thread.
**Action:** Extract the normalized option strings into a separate `useMemo` that only re-computes when the source array updates, and reuse those strings inside the deferred filtering loop.
## 2024-11-28 - Extract O(n) String Normalizations from Hot Filtering Loops
**Learning:** `searchInventoryItems` performs O(N) regex `.replace()` string normalizations. When called inside a functional React component rendering cycle (like inside a `useMemo` filter hook that depends on a `deferredQuery` for search fields), the string allocations and regex replacements block the main thread and cause noticeable input lag as the user types.
**Action:** Created `useInventorySearch` hook. It uses one `useMemo` to pre-compute the normalized option strings every time the items array changes (which happens rarely), and then returns a second `useMemo` that filters these strings using a lightweight `.includes()` query check (which executes fast per keystroke). This minimizes blocking per-keystroke operations in list filtering components.
## 2024-11-29 - Extract O(N) String Computations from Hot Loops
**Learning:** In list views (like `orders-list.tsx`), building searchable strings with `join(" ").toLocaleLowerCase("fa")` on every keystroke blocks the main thread.
**Action:** Extract these expensive string operations into an independent `useMemo` that relies only on the array data (`orderRows`). Then, filter by doing a fast `.includes()` over the pre-computed strings in the downstream hook.
## 2024-11-28 - Avoid Concatenating Strings for Fast Filtering Lookups
**Learning:** Extracting string normalizations into `useMemo` is a good optimization, but concatenating fields (like name and SKU) into a single string (`.join(" ")`) introduces subtle false-positive match bugs where a query can bridge across the boundary of the two concatenated values.
**Action:** When extracting O(n) computations into `useMemo`, store the normalized parts as separate properties (e.g., `nameLower`, `skuLower`) rather than concatenating them, and perform individual `.includes()` checks.
## 2025-02-23 - Caching computed object state
**Learning:** Re-computing expensive derived state like a ticket's status through an O(N) `Array.some()` call multiple times during render, filtering, and inside child components creates redundant work and slows down rendering.
**Action:** Compute the derived value once during the object's construction (e.g., inside a `useMemo` mapping function), cache it as a property on the object, and reference the cached property downstream.
