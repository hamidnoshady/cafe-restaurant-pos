import { describe, expect, it } from "vitest";
import { validateUsageEvent } from "./validate";

describe("validateUsageEvent", () => {
  it("accepts a known meter in its unit", () => {
    expect(
      validateUsageEvent({
        eventId: "evt-1",
        meterKey: "cms.bandwidth_bytes",
        quantity: 10,
        unit: "byte",
      }).ok,
    ).toBe(true);
  });

  it("rejects an unknown meter and a non-positive usage quantity", () => {
    expect(
      validateUsageEvent({ eventId: "evt-1", meterKey: "no.such", quantity: 1, unit: "byte" }),
    ).toEqual({ ok: false, code: "UNKNOWN_METER" });
    expect(
      validateUsageEvent({
        eventId: "evt-1",
        meterKey: "cms.bandwidth_bytes",
        quantity: 0,
        unit: "byte",
      }),
    ).toEqual({ ok: false, code: "INVALID_QUANTITY" });
  });
});
