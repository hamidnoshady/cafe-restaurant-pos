import { describe, expect, it } from "vitest";
import {
  MAX_SYNC_RETRIES,
  classifyFlushOutcome,
  isQueueEntryDueForRetry,
  resolveQueueRecordRef,
  retryBackoffMs,
} from "./sync-queue";

describe("resolveQueueRecordRef", () => {
  it("order.create has no server-assigned record id yet", () => {
    expect(resolveQueueRecordRef("order.create", { type: "dine_in" })).toEqual({
      table: "orders",
      recordId: null,
    });
  });

  it("order.add_items targets the existing order", () => {
    expect(resolveQueueRecordRef("order.add_items", { orderId: "ord_1", items: [] })).toEqual({
      table: "orders",
      recordId: "ord_1",
    });
  });

  it("order_item.status targets the item", () => {
    expect(resolveQueueRecordRef("order_item.status", { itemId: "item_1", status: "served" })).toEqual({
      table: "order_items",
      recordId: "item_1",
    });
  });

  it("falls back to unknown/null for a malformed payload", () => {
    expect(resolveQueueRecordRef("order.add_items", {})).toEqual({ table: "orders", recordId: null });
  });

  it("inventory.waste.recorded (Section 5 offline-queue extension) targets the wasted item, no server-assigned id yet", () => {
    expect(resolveQueueRecordRef("inventory.waste.recorded", { inventoryItemId: "item_1", quantity: "2" })).toEqual({
      table: "inventory_items",
      recordId: "item_1",
    });
  });

  it("inventory.waste.recorded falls back to null recordId for a malformed payload", () => {
    expect(resolveQueueRecordRef("inventory.waste.recorded", {})).toEqual({
      table: "inventory_items",
      recordId: null,
    });
  });
});

describe("retryBackoffMs", () => {
  it("doubles each retry starting at 5s", () => {
    expect(retryBackoffMs(1)).toBe(5_000);
    expect(retryBackoffMs(2)).toBe(10_000);
    expect(retryBackoffMs(3)).toBe(20_000);
  });

  it("caps at 5 minutes", () => {
    expect(retryBackoffMs(20)).toBe(5 * 60_000);
  });

  it("treats 0/negative as the first backoff step", () => {
    expect(retryBackoffMs(0)).toBe(5_000);
  });
});

describe("isQueueEntryDueForRetry", () => {
  const now = 1_000_000;

  it("always includes pending and syncing entries", () => {
    expect(isQueueEntryDueForRetry({ status: "pending", retryCount: 0 }, now)).toBe(true);
    expect(isQueueEntryDueForRetry({ status: "syncing", retryCount: 2 }, now)).toBe(true);
  });

  it("never includes completed or conflict entries", () => {
    expect(isQueueEntryDueForRetry({ status: "completed", retryCount: 0 }, now)).toBe(false);
    expect(isQueueEntryDueForRetry({ status: "conflict", retryCount: 0 }, now)).toBe(false);
  });

  it("excludes a failed entry still inside its backoff window", () => {
    expect(
      isQueueEntryDueForRetry({ status: "failed", retryCount: 3, lastAttemptAt: now - 1000 }, now),
    ).toBe(false);
  });

  it("includes a failed entry once its backoff window has elapsed", () => {
    const backoff = retryBackoffMs(3);
    expect(
      isQueueEntryDueForRetry({ status: "failed", retryCount: 3, lastAttemptAt: now - backoff }, now),
    ).toBe(true);
  });

  it("treats a missing lastAttemptAt as always due", () => {
    expect(isQueueEntryDueForRetry({ status: "failed", retryCount: 3 }, now)).toBe(true);
  });
});

describe("classifyFlushOutcome", () => {
  it("marks a plain success as completed", () => {
    expect(classifyFlushOutcome({ ok: true }, 0)).toEqual({ status: "completed", retryCount: 0 });
  });

  it("marks a flagged conflict as conflict, not completed or failed", () => {
    expect(classifyFlushOutcome({ ok: false, conflict: true }, 2)).toEqual({ status: "conflict", retryCount: 2 });
    // even an ok:true+conflict:true combination (shouldn't happen, but be defensive) is a conflict
    expect(classifyFlushOutcome({ ok: true, conflict: true }, 0)).toEqual({ status: "conflict", retryCount: 0 });
  });

  it("bumps retryCount and stays pending on a plain rejection below the cap", () => {
    expect(classifyFlushOutcome({ ok: false }, 0)).toEqual({ status: "pending", retryCount: 1 });
    expect(classifyFlushOutcome({ ok: false }, MAX_SYNC_RETRIES - 2)).toEqual({
      status: "pending",
      retryCount: MAX_SYNC_RETRIES - 1,
    });
  });

  it("moves to failed once the retry cap is hit", () => {
    expect(classifyFlushOutcome({ ok: false }, MAX_SYNC_RETRIES - 1)).toEqual({
      status: "failed",
      retryCount: MAX_SYNC_RETRIES,
    });
  });

  it("leaves retryCount untouched and stays pending when the server omitted this event from the response", () => {
    expect(classifyFlushOutcome(undefined, 3)).toEqual({ status: "pending", retryCount: 3 });
  });
});
