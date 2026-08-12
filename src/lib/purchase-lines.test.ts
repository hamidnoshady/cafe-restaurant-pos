import { describe, it, expect, vi, beforeEach } from "vitest";
import { preparePurchaseLines, purchaseDateOrNull, PurchaseLineError } from "./purchase-lines";
import * as db from "./db";

vi.mock("./db", () => ({ query: vi.fn() }));

/** Both routes hand this the location's items; only purchase_unit_factor matters here. */
function itemsInDb(rows: Array<{ id: string; purchase_unit_factor: string }>) {
  vi.mocked(db.query).mockResolvedValue({ rows } as never);
}

beforeEach(() => vi.mocked(db.query).mockReset());

describe("preparePurchaseLines", () => {
  it("converts purchase-unit quantity to base units and sums Rial exactly", async () => {
    itemsInDb([
      { id: "a", purchase_unit_factor: "1000" }, // kg -> g
      { id: "b", purchase_unit_factor: "1" },
    ]);

    const { lines, total } = await preparePurchaseLines(
      [
        { inventoryItemId: "a", purchaseQty: "2.5", totalCost: "1250000" },
        { inventoryItemId: "b", purchaseQty: "3", totalCost: "7" },
      ],
      "loc",
    );

    expect(lines).toEqual([
      { inventoryItemId: "a", baseQty: "2500", totalCost: "1250000" },
      { inventoryItemId: "b", baseQty: "3", totalCost: "7" },
    ]);
    expect(total).toBe("1250007");
  });

  it("sums beyond Number.MAX_SAFE_INTEGER without losing Rial", async () => {
    itemsInDb([{ id: "a", purchase_unit_factor: "1" }]);
    const { total } = await preparePurchaseLines(
      [
        { inventoryItemId: "a", purchaseQty: "1", totalCost: "9007199254740993" },
        { inventoryItemId: "a", purchaseQty: "1", totalCost: "1" },
      ],
      "loc",
    );
    expect(total).toBe("9007199254740994");
  });

  it("rejects an empty, malformed, or non-positive line", async () => {
    itemsInDb([{ id: "a", purchase_unit_factor: "1" }]);

    await expect(preparePurchaseLines([], "loc")).rejects.toMatchObject({ code: "no_items", status: 400 });
    for (const bad of [
      { purchaseQty: "1", totalCost: "1" }, // no item
      { inventoryItemId: "a", totalCost: "1" }, // no quantity
      { inventoryItemId: "a", purchaseQty: "0", totalCost: "1" },
      { inventoryItemId: "a", purchaseQty: "-1", totalCost: "1" },
      { inventoryItemId: "a", purchaseQty: "1", totalCost: "1.5" }, // Rial is integral
    ]) {
      await expect(preparePurchaseLines([bad], "loc")).rejects.toMatchObject({
        code: "invalid_item",
        status: 400,
      });
    }
  });

  it("refuses an item that belongs to another location", async () => {
    itemsInDb([]); // the location-scoped query found nothing
    await expect(
      preparePurchaseLines([{ inventoryItemId: "elsewhere", purchaseQty: "1", totalCost: "1" }], "loc"),
    ).rejects.toMatchObject({ code: "item_not_found", status: 404 });
  });

  it("throws PurchaseLineError so routes can map code/status", async () => {
    await expect(preparePurchaseLines([], "loc")).rejects.toBeInstanceOf(PurchaseLineError);
  });
});

describe("purchaseDateOrNull", () => {
  it("passes a valid ISO date through unchanged", () => {
    expect(purchaseDateOrNull("2026-08-11")).toBe("2026-08-11");
    expect(purchaseDateOrNull(" 2026-08-11 ")).toBe("2026-08-11");
  });

  it("reads a missing date as null — the caller decides what today means", () => {
    for (const empty of [undefined, null, "", "   "]) {
      expect(purchaseDateOrNull(empty)).toBeNull();
    }
  });

  it("rejects a malformed or non-existent date rather than letting Postgres 500", () => {
    for (const bad of [
      "2026-8-11", // unpadded
      "2026/08/11",
      "11-08-2026",
      "2026-08-11T00:00:00Z", // an instant, not a date
      "2026-13-01",
      "2026-02-31", // well-formed, but no such day
      "not-a-date",
      42,
    ]) {
      expect(() => purchaseDateOrNull(bad)).toThrow(PurchaseLineError);
      try {
        purchaseDateOrNull(bad);
      } catch (err) {
        expect(err).toMatchObject({ code: "invalid_purchase_date", status: 400 });
      }
    }
  });
});
