## 2024-08-07 - Add useDeferredValue to search queries
**Learning:** Typing in search fields can be slow if it immediately triggers complex filtering operations, causing the UI to become unresponsive.
**Action:** Apply `useDeferredValue` for fast inputs while deferring slow filtering tasks to improve rendering performance.
## 2023-10-27 - [Over-memoization]
 **Learning:** [Do not memoize primitives just because they are going into another useMemo. It is a React anti-pattern to memoize simple primitive types if the only purpose is keeping them stable for a subsequent hook, because primitives compare by value anyway.]
 **Action:** [Only useMemo for expensive derived state objects and arrays, not integers or simple strings.]
## 2026-08-14 - Deferred Search Input Filtering
**Learning:** Typing in search fields can be slow if it immediately triggers complex filtering operations, causing the UI to become unresponsive.
**Action:** Apply `useDeferredValue` for fast inputs while deferring slow filtering tasks to improve rendering performance.
