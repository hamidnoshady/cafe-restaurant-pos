import { describe, expect, it } from "vitest";
import { ORDER_OPENED_IN_WINDOW, isOrderStatus } from "./order-read-service";

describe("order-read-service", () => {
  describe("isOrderStatus", () => {
    it("returns true for valid order statuses", () => {
      expect(isOrderStatus("open")).toBe(true);
      expect(isOrderStatus("held")).toBe(true);
      expect(isOrderStatus("completed")).toBe(true);
      expect(isOrderStatus("voided")).toBe(true);
    });

    it("returns false for invalid order statuses", () => {
      expect(isOrderStatus("invalid")).toBe(false);
      expect(isOrderStatus("")).toBe(false);
      expect(isOrderStatus("OPEN")).toBe(false); // Case sensitivity
      expect(isOrderStatus("Open")).toBe(false); // Case sensitivity
      expect(isOrderStatus("pending")).toBe(false); // Valid in original task description, but not in current file!
    });
  });

  /**
   * A guard on the *column*, not on the whole string — the query itself is
   * covered by shift-closed-orders.integration.test.ts against a real database.
   * What this pins is the one thing that must never quietly come back: bucketing
   * a shift or a business day on `closed_at`, which credited a bill carried
   * across a cash-up to whichever shift happened to take the last payment and
   * dropped it from the shift that actually opened it.
   */
  describe("ORDER_OPENED_IN_WINDOW", () => {
    it("buckets on when the order was opened, never on when it was settled", () => {
      expect(ORDER_OPENED_IN_WINDOW).toContain("o.opened_at");
      expect(ORDER_OPENED_IN_WINDOW).not.toContain("closed_at");
    });

    it("leaves a live window open-ended rather than clamping it to now()", () => {
      expect(ORDER_OPENED_IN_WINDOW).toContain("$3::timestamptz IS NULL");
      expect(ORDER_OPENED_IN_WINDOW).not.toContain("now()");
    });
  });
});
