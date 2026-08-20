import { describe, expect, it } from "vitest";
import {
  ORDER_OPENED_IN_WINDOW,
  isOrderStatus,
  withoutCustomerContact,
} from "./order-read-service";

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

  /**
   * The reads themselves are DB-touching and covered by
   * integration/order-customer.integration.test.ts; this is the one pure part.
   * `ORDER_SUMMARY_SELECT` now joins the customer so the orders screen can show
   * whose bill it is, and both order lists share it — including the two the
   * public API serves. An `orders.read` key was never a grant over the customer
   * directory, so this projection is what keeps that payload where it was.
   */
  describe("withoutCustomerContact", () => {
    it("drops the name and phone but keeps customer_id and everything else", () => {
      expect(
        withoutCustomerContact({
          id: "order-1",
          order_number: 12,
          customer_id: "customer-1",
          customer_name: "مهسا رضایی",
          customer_phone: "09120000000",
          total: "1200000",
        }),
      ).toEqual({
        id: "order-1",
        order_number: 12,
        customer_id: "customer-1",
        total: "1200000",
      });
    });

    it("leaves a row that never had them untouched", () => {
      const row = { id: "order-2", customer_id: null, total: "0" };
      expect(withoutCustomerContact(row)).toEqual(row);
    });
  });
});
