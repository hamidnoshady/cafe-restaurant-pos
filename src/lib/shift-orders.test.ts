import { describe, expect, it } from "vitest";
import { groupShiftOrders, type ShiftOrderItemInput } from "./shift-orders";

function row(over: Partial<ShiftOrderItemInput> = {}): ShiftOrderItemInput {
  return {
    orderId: "o1",
    orderNumber: 102,
    type: "dine_in",
    status: "completed",
    tableName: "میز ۴",
    openedAt: "2026-08-11T11:42:00.000Z",
    orderTotal: 2_150_000,
    itemId: "i1",
    itemName: "اسپرسو",
    quantity: 1,
    unitPrice: 600_000,
    modifierDeltas: [],
    itemStatus: "served",
    note: null,
    ...over,
  };
}

describe("groupShiftOrders", () => {
  it("collapses the join into one entry per order, preserving row order", () => {
    const orders = groupShiftOrders([
      row({ itemId: "i1" }),
      row({ itemId: "i2", itemName: "کیک شکلاتی" }),
      row({ orderId: "o2", orderNumber: 103, type: "takeaway", tableName: null, itemId: "i3", itemName: "لاته" }),
    ]);
    expect(orders.map((o) => o.id)).toEqual(["o1", "o2"]);
    expect(orders[0]!.lines.map((l) => l.name)).toEqual(["اسپرسو", "کیک شکلاتی"]);
    expect(orders[1]!.lines).toHaveLength(1);
  });

  it("prices a line as (unit price + modifier deltas) × quantity", () => {
    const [order] = groupShiftOrders([
      row({ quantity: 2, unitPrice: 600_000, modifierDeltas: [50_000, -20_000] }),
    ]);
    expect(order!.lines[0]!.amount).toBe(1_260_000);
  });

  it("keeps voided lines flagged but out of the item count", () => {
    const [order] = groupShiftOrders([
      row({ itemId: "i1", quantity: 2 }),
      row({ itemId: "i2", quantity: 3, itemStatus: "voided" }),
    ]);
    expect(order!.itemCount).toBe(2);
    expect(order!.lines.map((l) => l.voided)).toEqual([false, true]);
  });

  it("keeps an order that has no lines yet", () => {
    const [order] = groupShiftOrders([row({ status: "open", itemId: null, itemName: null, itemStatus: null })]);
    expect(order!.lines).toEqual([]);
    expect(order!.itemCount).toBe(0);
  });

  it("reports the order's own total, not the sum of its lines", () => {
    const [order] = groupShiftOrders([row({ orderTotal: 2_150_000, unitPrice: 600_000, quantity: 1 })]);
    expect(order!.total).toBe(2_150_000);
  });
});
