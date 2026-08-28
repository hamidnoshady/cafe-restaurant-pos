## 2024-05-18 - Redundant Array Creation in Loops
**Learning:** Found an O(G * L) array creation issue where `Array.from` was being called inside a map iteration across multiple table line items.
**Action:** Always extract dynamically built option arrays that depend solely on component state (e.g. `guestCount`) into a `useMemo` above the render loop to prevent redundant allocations and maintain referential equality.
## 2025-02-23 - Memoizing Arrays Without Hoisting Filter Breaks Cache
**Learning:** Extracting an options array into a `useMemo` to prevent per-render reallocation fails if the data it depends on is created via `.filter()` directly in the render body. `.filter()` creates a new array reference every render, causing the `useMemo` dependency check to fail and recalculate anyway.
**Action:** Always move the `.filter()` operation inside the `useMemo` block and depend on the raw data array, or memoize the `.filter()` result itself before passing it to subsequent derived state hooks.
