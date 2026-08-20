import { useMemo } from "react";
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

/**
 * ⚡ Bolt: A hook to prevent re-calculating string normalizations
 * during fast typing. By pre-computing the searchable strings once per items array update,
 * we keep typing lag minimal because the per-keystroke cost is just a simple `.includes()`.
 */
export function useInventorySearch<T extends SearchableInventoryItem>(
  items: T[],
  query: string,
): T[] {
  // Pre-compute the searchable, normalized text for every item.
  // This will only re-run when the `items` array changes, not on every keystroke.
  const normalizedItems = useMemo(() => {
    return items.map((item) => {
      const searchable = [item.name, item.sku ?? "", item.unit]
        .filter(Boolean)
        .join(" ");
      return { item, searchString: normalizePosSearchText(searchable) };
    });
  }, [items]);

  // Use the pre-computed array for filtering based on the current query.
  const filteredItems = useMemo(() => {
    const normalizedQuery = normalizePosSearchText(query);
    if (!normalizedQuery) return items;
    return normalizedItems
      .filter((ni) => ni.searchString.includes(normalizedQuery))
      .map((ni) => ni.item);
  }, [items, normalizedItems, query]);

  return filteredItems;
}
