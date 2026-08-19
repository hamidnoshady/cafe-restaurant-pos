import { describe, expect, it } from "vitest";
import {
  cartQuantitiesByItem,
  isGlobalCashierShortcutEligible,
  listSelectableTables,
  missingCheckoutRequirement,
  normalizePosSearchText,
  requiresTableSelection,
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
  {
    id: "secret",
    category_id: "hidden",
    name: "نوشیدنی ویژه",
    is_active: true,
  },
];

const tables = [
  { id: "t1", name: "میز ۱", capacity: 2 },
  { id: "t2", name: "میز ۲", capacity: 4 },
  { id: "b1", name: "بار ۱", capacity: 1 },
];

describe("POS selection helpers", () => {
  it("normalizes Arabic letter variants, Persian and Arabic digits, whitespace, and case for POS search", () => {
    expect(normalizePosSearchText("  كِیك ١۲  ")).toBe("کیک 12");
  });

  it("keeps an empty POS search inside the selected active category", () => {
    expect(
      searchPosMenuItems({
        categories,
        items,
        selectedCategoryId: "hot",
        query: "   ",
      }),
    ).toEqual([
      {
        id: "tea",
        category_id: "hot",
        name: "چای ۱۲",
        is_active: true,
        categoryLabel: "نوشیدنی گرم",
      },
      {
        id: "latte",
        category_id: "hot",
        name: "لاته",
        is_active: true,
        categoryLabel: "نوشیدنی گرم",
      },
    ]);
  });

  it("finds active POS products across categories by normalized product or category name", () => {
    expect(
      searchPosMenuItems({
        categories,
        items,
        selectedCategoryId: "hot",
        query: "نوشيدني سرد",
      }),
    ).toEqual([
      {
        id: "cola",
        category_id: "cold",
        name: "کولا",
        is_active: true,
        categoryLabel: "نوشیدنی سرد",
      },
    ]);
  });

  it("blocks global cashier shortcuts for editable focus and open dialogs", () => {
    expect(
      isGlobalCashierShortcutEligible({
        activeElement: { tagName: "INPUT" },
        hasOpenDialog: false,
      }),
    ).toBe(false);
    expect(
      isGlobalCashierShortcutEligible({
        activeElement: { tagName: "DIV", isContentEditable: true },
        hasOpenDialog: false,
      }),
    ).toBe(false);
    expect(
      isGlobalCashierShortcutEligible({
        activeElement: null,
        hasOpenDialog: true,
      }),
    ).toBe(false);
    expect(
      isGlobalCashierShortcutEligible({
        activeElement: { tagName: "BUTTON" },
        hasOpenDialog: false,
      }),
    ).toBe(true);
  });

  it("asks for a table only when an in-person sale still has none", () => {
    expect(requiresTableSelection({ orderType: "dine_in", tableId: "" })).toBe(
      true,
    );
    expect(
      requiresTableSelection({ orderType: "dine_in", tableId: "  " }),
    ).toBe(true);
    expect(
      requiresTableSelection({ orderType: "dine_in", tableId: "t1" }),
    ).toBe(false);
    expect(requiresTableSelection({ orderType: "takeaway", tableId: "" })).toBe(
      false,
    );
    expect(requiresTableSelection({ orderType: "delivery", tableId: "" })).toBe(
      false,
    );
  });

  it("marks occupied tables instead of hiding them, keeping registration order", () => {
    expect(
      listSelectableTables({ tables, occupiedTableIds: ["t1"], query: "" }),
    ).toEqual([
      { id: "t1", name: "میز ۱", capacity: 2, occupied: true },
      { id: "t2", name: "میز ۲", capacity: 4, occupied: false },
      { id: "b1", name: "بار ۱", capacity: 1, occupied: false },
    ]);
  });

  it("filters the table prompt by normalized name, so Latin digits and Arabic letters still match", () => {
    expect(
      listSelectableTables({
        tables,
        occupiedTableIds: [],
        query: "ميز 2",
      }).map((table) => table.id),
    ).toEqual(["t2"]);
    expect(
      listSelectableTables({ tables, occupiedTableIds: [], query: "بار" }).map(
        (table) => table.id,
      ),
    ).toEqual(["b1"]);
    expect(
      listSelectableTables({
        tables,
        occupiedTableIds: [],
        query: "انبار طبقهٔ دوم",
      }),
    ).toEqual([]);
  });

  /**
   * A product tile says how many of itself are in the cart, and one product can
   * sit on several lines: two lattes with different add-ons are deliberately not
   * merged, so the badge is a sum rather than a lookup.
   */
  it("sums a product's quantity across every line it sits on", () => {
    const totals = cartQuantitiesByItem([
      { menuItemId: "latte", quantity: 2 },
      { menuItemId: "tea", quantity: 1 },
      { menuItemId: "latte", quantity: 3 },
    ]);
    expect(totals.get("latte")).toBe(5);
    expect(totals.get("tea")).toBe(1);
    expect(totals.get("cola")).toBeUndefined();
  });

  it("counts nothing for an empty cart", () => {
    expect(cartQuantitiesByItem([]).size).toBe(0);
  });

  /**
   * The delivery case is the one this exists for: the buttons used to be enabled
   * on any non-empty cart, so an order with no address was refused only by the
   * final press, three screens past the empty field.
   */
  it("names what is still missing, in the order the cashier can act on it", () => {
    const base = { orderType: "delivery", tableId: "", deliveryAddress: "", lineCount: 0 };
    expect(missingCheckoutRequirement(base)).toBe("empty_cart");
    expect(missingCheckoutRequirement({ ...base, lineCount: 2 })).toBe(
      "delivery_address_required",
    );
    expect(
      missingCheckoutRequirement({ ...base, lineCount: 2, deliveryAddress: "  " }),
    ).toBe("delivery_address_required");
    expect(
      missingCheckoutRequirement({
        ...base,
        lineCount: 2,
        deliveryAddress: "خیابان ولیعصر",
      }),
    ).toBeNull();
  });

  it("asks an in-person sale for its table, and lets every other type through", () => {
    const cart = { deliveryAddress: "", lineCount: 1 };
    expect(
      missingCheckoutRequirement({ ...cart, orderType: "dine_in", tableId: "" }),
    ).toBe("table_required");
    expect(
      missingCheckoutRequirement({ ...cart, orderType: "dine_in", tableId: "t1" }),
    ).toBeNull();
    expect(
      missingCheckoutRequirement({ ...cart, orderType: "takeaway", tableId: "" }),
    ).toBeNull();
  });
});
