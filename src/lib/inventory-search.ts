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