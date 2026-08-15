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
