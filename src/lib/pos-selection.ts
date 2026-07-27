export type PosSearchCategory = {
  id: string;
  name: string;
  is_active: boolean;
};

export type PosSearchMenuItem = {
  id: string;
  category_id: string;
  name: string;
  is_active: boolean;
};

export type PosSearchResult = PosSearchMenuItem & {
  categoryLabel: string;
};

export type PosSearchInput = {
  categories: PosSearchCategory[];
  items: PosSearchMenuItem[];
  selectedCategoryId: string;
  query: string;
};

export type ShortcutInteractionTarget = {
  tagName?: string;
  isContentEditable?: boolean;
};

export type GlobalCashierShortcutInput = {
  activeElement: ShortcutInteractionTarget | null;
  hasOpenDialog: boolean;
};

const arabicDigitPattern = /[٠-٩]/g;
const persianDigitPattern = /[۰-۹]/g;
const arabicDiacriticPattern = /[\u064B-\u065F\u0670]/g;

export function normalizePosSearchText(value: string): string {
  return value
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(arabicDigitPattern, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(persianDigitPattern, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(arabicDiacriticPattern, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("fa");
}

export function searchPosMenuItems({ categories, items, selectedCategoryId, query }: PosSearchInput): PosSearchResult[] {
  const activeCategories = new Map(categories.filter((category) => category.is_active).map((category) => [category.id, category]));
  const normalizedQuery = normalizePosSearchText(query);

  return items.flatMap((item) => {
    const category = activeCategories.get(item.category_id);
    if (!item.is_active || !category) return [];
    if (!normalizedQuery && item.category_id !== selectedCategoryId) return [];
    if (normalizedQuery && !normalizePosSearchText(item.name).includes(normalizedQuery) && !normalizePosSearchText(category.name).includes(normalizedQuery)) return [];

    return [{ ...item, categoryLabel: category.name }];
  });
}

export function isGlobalCashierShortcutEligible({ activeElement, hasOpenDialog }: GlobalCashierShortcutInput): boolean {
  if (hasOpenDialog || !activeElement) return !hasOpenDialog;

  const tagName = activeElement.tagName?.toLowerCase();
  return !activeElement.isContentEditable && tagName !== "input" && tagName !== "textarea" && tagName !== "select";
}
