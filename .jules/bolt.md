## 2024-05-18 - Redundant Array Creation in Loops
**Learning:** Found an O(G * L) array creation issue where `Array.from` was being called inside a map iteration across multiple table line items.
**Action:** Always extract dynamically built option arrays that depend solely on component state (e.g. `guestCount`) into a `useMemo` above the render loop to prevent redundant allocations and maintain referential equality.
## 2025-02-23 - Memoizing Arrays Without Hoisting Filter Breaks Cache
**Learning:** Extracting an options array into a `useMemo` to prevent per-render reallocation fails if the data it depends on is created via `.filter()` directly in the render body. `.filter()` creates a new array reference every render, causing the `useMemo` dependency check to fail and recalculate anyway.
**Action:** Always move the `.filter()` operation inside the `useMemo` block and depend on the raw data array, or memoize the `.filter()` result itself before passing it to subsequent derived state hooks.

## 2026-09-01 - Extract Category Filtering from Render Loop
**Learning:** Filtering a large array of N items for each of C categories within a render loop causes O(N*C) computations, which blocks the main thread during high-frequency events like text searching. Extracting it to a useMemo block using `.filter()` creates new arrays each time, breaking the cache unless dependencies are correct.
**Action:** Use a single O(N) pass to group items into a `Map<string, Item[]>` inside `useMemo`, allowing O(1) lookups during the category render loop and maintaining stable references.
## 2024-11-20 - Memoizing Options Arrays Driven by Input State
**Learning:** In React list views or search dialogs, arrays that require string normalization (like `toPersianDigits`) or regex operations for each item can become a severe performance bottleneck if recreated on every keystroke. Specifically, in `src/app/dashboard/floor/session-panel.tsx`, `customerOptions` was recomputed on every render (driven by a `customerQuery` input state), which caused jank on large datasets.
**Action:** When an options array relies on a base dataset (like `customers`) but the component has rapid state updates (like text inputs), wrap the array creation in a `useMemo` dependent only on the base dataset (e.g. `[customers]`). Ensure you extract any expensive string normalization into the memoized block.
## 2026-09-11 - Documenting useDeferredValue Intentions
**Learning:** When using `useDeferredValue` and a precomputed search index as a React list view performance optimization, missing comments on these mechanisms can be rejected in code review because it violates 'Bolt' persona rules about code documentation.
**Action:** Always add inline comments explaining the `useDeferredValue` deferral and the O(N) pre-computation index optimizations directly in the code to ensure intent is clear.
## 2024-09-12 - O(N) filtering inside list rendering

**Learning:** When a list view (like the POS screen products list) calls a seemingly lightweight helper function (`attachedGroups`) that filters arrays under the hood on every item mapping iteration, it causes significant typing delay in search bars due to repeated O(N * M) calculations on the main thread.

**Action:** Identify and lift expensive O(N) array filtering operations from inside `.map()` render loops by using `useMemo` to construct a pre-computed data structure (like a `Map`) keyed by the entity ID, allowing the render loop to perform fast O(1) lookups instead.

## 2024-05-18 - Deferred UI Blocking Search Operations
**Learning:** React state updates block user input events if they trigger expensive UI recalculations (like filtering lists or complex object mapping).
**Action:** Always wrap `search` state variables in `useDeferredValue` when those inputs drive heavy DOM re-renders or data manipulation (`useMemo`), isolating the typing responsiveness from the cost of the result update.
