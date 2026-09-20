import { describe, expect, it } from "vitest";
import {
  cartQuantitiesByItem,
  isGlobalCashierShortcutEligible,
  listSelectableTables,
  missingCheckoutRequirement,
  normalizePosSearchText,
  requiresTableSelection,
  searchPosMenuItems,
  warmPosItemSearchCache,
  type PosSearchCategory,
  type PosSearchMenuItem,
} from "./pos-selection";

const categories: PosSearchCategory[] = [
  { id: "hot", name: "نوشیدنی گرم", taxRate: 10, isActive: true, sortOrder: 0 },
  { id: "cold", name: "نوشیدنی سرد", taxRate: 10, isActive: true, sortOrder: 1 },
  { id: "hidden", name: "مخفی", taxRate: 0, isActive: false, sortOrder: 2 },
];

const item = (
  base: Pick<PosSearchMenuItem, "id" | "categoryId" | "name"> & {
    isActive: boolean;
    sku?: string | null;
  },
): PosSearchMenuItem => ({
  description: null,
  sku: null,
  price: 100_000,
  imageUrl: null,
  imageMediaId: null,
  sortOrder: 0,
  targetMarginPercent: null,
  ...base,
});

const items: PosSearchMenuItem[] = [
  item({ id: "tea", categoryId: "hot", name: "چای ۱۲", isActive: true }),
  item({ id: "latte", categoryId: "hot", name: "لاته", isActive: true, sku: "HOT-LATTE" }),
  item({ id: "cola", categoryId: "cold", name: "کولا", isActive: true, sku: "CLD-۱" }),
  item({ id: "water", categoryId: "cold", name: "آب", isActive: false }),
  item({ id: "secret", categoryId: "hidden", name: "نوشیدنی ویژه", isActive: true }),
];
warmPosItemSearchCache(items);

const tables = [
  { id: "t1", name: "میز ۱", capacity: 2, status: "seated" },
  { id: "t2", name: "میز ۲", capacity: 4, status: "free" },
  { id: "b1", name: "بار ۱", capacity: 1, status: "cleaning" },
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
      { ...items[0], categoryLabel: "نوشیدنی گرم" },
      { ...items[1], categoryLabel: "نوشیدنی گرم" },
    ]);
  });

  it("finds an item by its SKU, with Persian digits normalized", () => {
    const byLatinSku = searchPosMenuItems({
      categories,
      items,
      selectedCategoryId: "hot",
      query: "hot-latte",
    });
    expect(byLatinSku.map((row) => row.id)).toEqual(["latte"]);

    const byPersianDigitSku = searchPosMenuItems({
      categories,
      items,
      selectedCategoryId: "hot",
      query: "cld-۱",
    });
    expect(byPersianDigitSku.map((row) => row.id)).toEqual(["cola"]);
  });

  it("does not leak an inactive item through its SKU", () => {
    expect(
      searchPosMenuItems({
        categories,
        items,
        selectedCategoryId: "cold",
        query: "آب",
      }),
    ).toEqual([]);
  });

  it("finds active POS products across categories by normalized product or category name", () => {
    expect(
      searchPosMenuItems({
        categories,
        items,
        selectedCategoryId: "hot",
        query: "نوشيدني سرد",
      }),
    ).toEqual([{ ...items[2], categoryLabel: "نوشیدنی سرد" }]);
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

  /**
   * A seated table stays offered: a friend joining a busy table is a second,
   * separate bill on it. Only cleaning / out-of-service is refused, matching
   * what createOrder refuses server-side.
   */
  it("offers a seated table as a separate bill, and refuses only an unavailable one", () => {
    expect(listSelectableTables({ tables, query: "" })).toEqual([
      {
        id: "t1",
        name: "میز ۱",
        capacity: 2,
        status: "seated",
        occupied: true,
        unavailable: false,
      },
      {
        id: "t2",
        name: "میز ۲",
        capacity: 4,
        status: "free",
        occupied: false,
        unavailable: false,
      },
      {
        id: "b1",
        name: "بار ۱",
        capacity: 1,
        status: "cleaning",
        occupied: false,
        unavailable: true,
      },
    ]);
  });

  it("counts a table waiting for its bill as occupied, not as unavailable", () => {
    const [table] = listSelectableTables({
      tables: [{ id: "t9", name: "میز ۹", capacity: 2, status: "bill_requested" }],
      query: "",
    });
    expect(table.occupied).toBe(true);
    expect(table.unavailable).toBe(false);
  });

  it("filters the table prompt by normalized name, so Latin digits and Arabic letters still match", () => {
    expect(
      listSelectableTables({
        tables,
        query: "ميز 2",
      }).map((table) => table.id),
    ).toEqual(["t2"]);
    expect(
      listSelectableTables({ tables, query: "بار" }).map((table) => table.id),
    ).toEqual(["b1"]);
    expect(
      listSelectableTables({
        tables,
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
