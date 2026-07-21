import { describe, expect, it } from "vitest";
import { classifyStatusReplay } from "./offline-sync";

describe("classifyStatusReplay", () => {
  it("applies a legal kitchen bump", () => {
    expect(classifyStatusReplay("sent", "preparing", "kitchen")).toBe("apply");
    expect(classifyStatusReplay("preparing", "ready", "kitchen")).toBe("apply");
  });

  it("applies a legal waiter/cashier serve", () => {
    expect(classifyStatusReplay("ready", "served", "waiter")).toBe("apply");
    expect(classifyStatusReplay("ready", "served", "cashier")).toBe("apply");
  });

  it("owner/manager can do either", () => {
    expect(classifyStatusReplay("sent", "preparing", "owner")).toBe("apply");
    expect(classifyStatusReplay("ready", "served", "manager")).toBe("apply");
  });

  it("treats replaying the same target status as a harmless duplicate", () => {
    // e.g. two kitchen devices both bumped sent->preparing while offline
    expect(classifyStatusReplay("preparing", "preparing", "kitchen")).toBe("duplicate");
    expect(classifyStatusReplay("served", "served", "waiter")).toBe("duplicate");
  });

  it("flags a stale transition as a conflict instead of silently dropping it", () => {
    // one device's queued "preparing" arrives after another already bumped to "ready"
    expect(classifyStatusReplay("ready", "preparing", "kitchen")).toBe("conflict");
    // item was voided (by another device) while this one queued a bump
    expect(classifyStatusReplay("voided", "preparing", "kitchen")).toBe("conflict");
  });

  it("flags a role doing the wrong kind of transition as a conflict", () => {
    // waiter cannot kitchen-bump
    expect(classifyStatusReplay("sent", "preparing", "waiter")).toBe("conflict");
    // kitchen cannot mark served
    expect(classifyStatusReplay("ready", "served", "kitchen")).toBe("conflict");
  });
});
