import { describe, expect, it } from "vitest";
import {
  canTransitionDelivery,
  computeDeliveryMinutes,
  DELIVERY_STATUSES,
  deliveryStatusLabel,
  isDeliveryStatus,
  isTerminalDeliveryStatus,
  requiresCourier,
} from "./delivery";

describe("delivery status transitions", () => {
  it("follows the happy path pending → assigned → out_for_delivery → delivered", () => {
    expect(canTransitionDelivery("pending", "assigned")).toBe(true);
    expect(canTransitionDelivery("assigned", "out_for_delivery")).toBe(true);
    expect(canTransitionDelivery("out_for_delivery", "delivered")).toBe(true);
  });

  it("allows failing from any non-terminal state", () => {
    expect(canTransitionDelivery("pending", "failed")).toBe(true);
    expect(canTransitionDelivery("assigned", "failed")).toBe(true);
    expect(canTransitionDelivery("out_for_delivery", "failed")).toBe(true);
  });

  it("allows undoing an assignment before dispatch", () => {
    expect(canTransitionDelivery("assigned", "pending")).toBe(true);
  });

  it("rejects skipping straight to out_for_delivery without a courier", () => {
    expect(canTransitionDelivery("pending", "out_for_delivery")).toBe(false);
  });

  it("rejects transitions out of terminal states", () => {
    expect(canTransitionDelivery("delivered", "out_for_delivery")).toBe(false);
    expect(canTransitionDelivery("failed", "pending")).toBe(false);
    expect(canTransitionDelivery("delivered", "failed")).toBe(false);
  });

  it("rejects no-op transitions to the same status", () => {
    expect(canTransitionDelivery("pending", "pending")).toBe(false);
  });
});

describe("delivery status predicates", () => {
  it("recognizes terminal statuses", () => {
    expect(isTerminalDeliveryStatus("delivered")).toBe(true);
    expect(isTerminalDeliveryStatus("failed")).toBe(true);
    expect(isTerminalDeliveryStatus("pending")).toBe(false);
    expect(isTerminalDeliveryStatus("out_for_delivery")).toBe(false);
  });

  it("requires a courier once out for delivery or delivered", () => {
    expect(requiresCourier("out_for_delivery")).toBe(true);
    expect(requiresCourier("delivered")).toBe(true);
    expect(requiresCourier("pending")).toBe(false);
    expect(requiresCourier("assigned")).toBe(false);
  });

  it("validates raw status strings", () => {
    expect(isDeliveryStatus("out_for_delivery")).toBe(true);
    expect(isDeliveryStatus("teleported")).toBe(false);
  });

  it("has a Persian label for every status", () => {
    for (const s of DELIVERY_STATUSES) {
      expect(deliveryStatusLabel(s)).toBeTruthy();
      expect(deliveryStatusLabel(s)).not.toBe(s);
    }
  });
});

describe("computeDeliveryMinutes", () => {
  it("rounds elapsed minutes between dispatch and delivery", () => {
    expect(computeDeliveryMinutes("2026-07-22T10:00:00Z", "2026-07-22T10:27:00Z")).toBe(27);
    expect(computeDeliveryMinutes("2026-07-22T10:00:00Z", "2026-07-22T10:27:40Z")).toBe(28);
  });

  it("returns null when a timestamp is missing", () => {
    expect(computeDeliveryMinutes(null, "2026-07-22T10:27:00Z")).toBeNull();
    expect(computeDeliveryMinutes("2026-07-22T10:00:00Z", null)).toBeNull();
  });

  it("returns null when delivery precedes dispatch (clock skew / bad data)", () => {
    expect(computeDeliveryMinutes("2026-07-22T10:30:00Z", "2026-07-22T10:00:00Z")).toBeNull();
  });
});
