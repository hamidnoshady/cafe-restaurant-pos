## 2024-05-18 - Redundant Array Creation in Loops
**Learning:** Found an O(G * L) array creation issue where `Array.from` was being called inside a map iteration across multiple table line items.
**Action:** Always extract dynamically built option arrays that depend solely on component state (e.g. `guestCount`) into a `useMemo` above the render loop to prevent redundant allocations and maintain referential equality.
