## 2024-08-07 - Add useDeferredValue to search queries
**Learning:** Typing in search fields can be slow if it immediately triggers complex filtering operations, causing the UI to become unresponsive.
**Action:** Apply `useDeferredValue` for fast inputs while deferring slow filtering tasks to improve rendering performance.

## 2024-08-11 - Prevent race conditions when deferring search queries
**Learning:** Using `useDeferredValue` for search inputs can introduce a critical functional regression in POS environments where users type fast or use barcode scanners. If a user presses "Enter" while the input value has updated but the deferred value is still stale, the event handler might use the stale state.
**Action:** Whenever deferring search queries, always check for staleness (e.g., `searchQuery !== deferredSearchQuery`) in submission event handlers to prevent actions on outdated filtered results.
