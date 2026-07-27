import { describe, expect, it } from "vitest";
import {
  isGlobalCashierShortcutEligible,
  normalizePosSearchText,
  searchPosMenuItems,
} from "./pos-selection";

const categories = [
  { id: "hot", name: "نوشیدنی گرم", is_active: true },
  { id: "cold", name: "نوشیدنی سرد", is_active: true },
  { id: "hidden", name: "مخفی", is_active: false },
];

const items = [
  { id: "tea", category_id: "hot", name: "چای ۱۲", is_active: true },
  { id: "latte", category_id: "hot", name: "لاته", is_active: true },
  { id: "cola", category_id: "cold", name: "کولا", is_active: true },
  { id: "water", category_id: "cold", name: "آب", is_active: false },
  { id: "secret", category_id: "hidden", name: "نوشیدنی ویژه", is_active: true },
];

describe("POS selection helpers", () => {
  it("normalizes Arabic letter variants, Persian and Arabic digits, whitespace, and case for POS search", () => {
    expect(normalizePosSearchText("  كِیك ١۲  ")).toBe("کیک 12");
  });

  it("keeps an empty POS search inside the selected active category", () => {
    expect(searchPosMenuItems({ categories, items, selectedCategoryId: "hot", query: "   " }))
      .toEqual([
        { id: "tea", category_id: "hot", name: "چای ۱۲", is_active: true, categoryLabel: "نوشیدنی گرم" },
        { id: "latte", category_id: "hot", name: "لاته", is_active: true, categoryLabel: "نوشیدنی گرم" },
      ]);
  });

  it("finds active POS products across categories by normalized product or category name", () => {
    expect(searchPosMenuItems({ categories, items, selectedCategoryId: "hot", query: "نوشيدني سرد" }))
      .toEqual([
        { id: "cola", category_id: "cold", name: "کولا", is_active: true, categoryLabel: "نوشیدنی سرد" },
      ]);
  });

  it("blocks global cashier shortcuts for editable focus and open dialogs", () => {
    expect(isGlobalCashierShortcutEligible({ activeElement: { tagName: "INPUT" }, hasOpenDialog: false })).toBe(false);
    expect(isGlobalCashierShortcutEligible({ activeElement: { tagName: "DIV", isContentEditable: true }, hasOpenDialog: false })).toBe(false);
    expect(isGlobalCashierShortcutEligible({ activeElement: null, hasOpenDialog: true })).toBe(false);
    expect(isGlobalCashierShortcutEligible({ activeElement: { tagName: "BUTTON" }, hasOpenDialog: false })).toBe(true);
  });
});
