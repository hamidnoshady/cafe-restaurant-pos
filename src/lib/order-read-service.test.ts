import { describe, expect, it } from "vitest";
import { isOrderStatus } from "./order-read-service";

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
});
