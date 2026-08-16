## 2024-08-07 - Add useDeferredValue to search queries
**Learning:** Typing in search fields can be slow if it immediately triggers complex filtering operations, causing the UI to become unresponsive.
**Action:** Apply `useDeferredValue` for fast inputs while deferring slow filtering tasks to improve rendering performance.
## 2024-08-16 - Separate static grouping from tick-based priority updates in KDS
**Learning:** Combining static data grouping and date parsing with an interval-driven priority calculation in a single `useMemo` causes expensive, redundant object re-creations and loop iterations every time the interval ticks.
**Action:** Separate static operations (grouping, min/max calculations, parsing) into their own `useMemo` that only depends on the raw data. Feed that result into a separate `useMemo` that applies the time-dependent changes on each tick.
