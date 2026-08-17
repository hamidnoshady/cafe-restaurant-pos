import { describe, expect, it } from "vitest";
import {
  businessDateOf,
  instantInTimeZone,
  MAX_BACKDATE_DAYS,
  MAX_LINE_QUANTITY,
  parseInstant,
  validateBackdatedOrder,
  type BackdatedOrderInput,
} from "./backdated-orders";

const NOW = new Date("2026-08-17T12:00:00.000Z");

function input(overrides: Partial<BackdatedOrderInput> = {}): BackdatedOrderInput {
  return {
    occurredAt: "2026-08-11T19:30:00.000Z",
    type: "takeaway",
    reason: "شب قطعی برق، فاکتورها دستی نوشته شد",
    lines: [{ menuItemId: "11111111-1111-1111-1111-111111111111", quantity: 2 }],
    payments: [{ method: "cash" }],
    ...overrides,
  };
}

describe("validateBackdatedOrder", () => {
  it("accepts a past sale and normalises its parts", () => {
    const result = validateBackdatedOrder(input({ note: "  میز بیرون  " }), { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.occurredAt.toISOString()).toBe("2026-08-11T19:30:00.000Z");
    expect(result.value.type).toBe("takeaway");
    expect(result.value.note).toBe("میز بیرون");
    expect(result.value.lines).toEqual([
      { menuItemId: "11111111-1111-1111-1111-111111111111", quantity: 2, note: null, modifierIds: [] },
    ]);
    expect(result.value.discount).toEqual({ type: null, value: 0 });
    expect(result.value.tipAmount).toBe(0);
  });

  it("rejects a sale dated in the future", () => {
    const result = validateBackdatedOrder(input({ occurredAt: "2026-08-18T09:00:00.000Z" }), { now: NOW });
    expect(result).toEqual({ ok: false, error: "occurred_at_in_future" });
  });

  it("absorbs clock skew rather than rejecting a browser a minute ahead", () => {
    const result = validateBackdatedOrder(input({ occurredAt: "2026-08-17T12:01:00.000Z" }), { now: NOW });
    expect(result.ok).toBe(true);
  });

  it("rejects a sale older than the back-dating window — the mistyped-year case", () => {
    const tooOld = new Date(NOW.getTime() - (MAX_BACKDATE_DAYS + 1) * 86_400_000).toISOString();
    const result = validateBackdatedOrder(input({ occurredAt: tooOld }), { now: NOW });
    expect(result).toEqual({ ok: false, error: "occurred_at_too_old" });
  });

  it("rejects an unparseable instant", () => {
    expect(validateBackdatedOrder(input({ occurredAt: "1405/05/26" }), { now: NOW })).toEqual({
      ok: false,
      error: "invalid_occurred_at",
    });
    expect(validateBackdatedOrder(input({ occurredAt: "2026-08-11T19:30:00" }), { now: NOW })).toEqual({
      ok: false,
      error: "invalid_occurred_at",
    });
    expect(validateBackdatedOrder(input({ occurredAt: null }), { now: NOW })).toEqual({
      ok: false,
      error: "invalid_occurred_at",
    });
  });

  it("requires a real reason", () => {
    expect(validateBackdatedOrder(input({ reason: "  " }), { now: NOW })).toEqual({
      ok: false,
      error: "invalid_reason",
    });
    expect(validateBackdatedOrder(input({ reason: "ok" }), { now: NOW })).toEqual({
      ok: false,
      error: "invalid_reason",
    });
    expect(validateBackdatedOrder(input({ reason: "x".repeat(501) }), { now: NOW })).toEqual({
      ok: false,
      error: "invalid_reason",
    });
  });

  it("rejects an order type the till does not have", () => {
    expect(validateBackdatedOrder(input({ type: "retail" }), { now: NOW })).toEqual({
      ok: false,
      error: "invalid_order_type",
    });
  });

  it("requires at least one line, one payment way, and sane quantities", () => {
    expect(validateBackdatedOrder(input({ lines: [] }), { now: NOW })).toEqual({ ok: false, error: "no_items" });
    expect(validateBackdatedOrder(input({ payments: [] }), { now: NOW })).toEqual({
      ok: false,
      error: "no_payment",
    });
    expect(
      validateBackdatedOrder(input({ lines: [{ menuItemId: "a", quantity: 0 }] }), { now: NOW }),
    ).toEqual({ ok: false, error: "invalid_quantity" });
    expect(
      validateBackdatedOrder(input({ lines: [{ menuItemId: "a", quantity: MAX_LINE_QUANTITY + 1 }] }), {
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "invalid_quantity" });
    expect(validateBackdatedOrder(input({ lines: [{ quantity: 1 }] }), { now: NOW })).toEqual({
      ok: false,
      error: "invalid_item",
    });
  });

  it("rejects a discount the cart screen could not have produced", () => {
    expect(
      validateBackdatedOrder(input({ discount: { type: "percent", value: 120 } }), { now: NOW }),
    ).toEqual({ ok: false, error: "invalid_discount" });
    expect(
      validateBackdatedOrder(input({ discount: { type: "amount", value: -1 } }), { now: NOW }),
    ).toEqual({ ok: false, error: "invalid_discount" });
  });

  it("rejects a fractional or negative tip", () => {
    expect(validateBackdatedOrder(input({ tipAmount: 1.5 }), { now: NOW })).toEqual({
      ok: false,
      error: "invalid_tip_amount",
    });
    expect(validateBackdatedOrder(input({ tipAmount: -1000 }), { now: NOW })).toEqual({
      ok: false,
      error: "invalid_tip_amount",
    });
  });
});

describe("businessDateOf", () => {
  it("is the calendar day in the branch's own zone when no business day is configured", () => {
    // 20:30 UTC on the 16th is 00:00 on the 17th in Tehran (UTC+3:30).
    expect(businessDateOf(new Date("2026-08-16T20:30:00.000Z"), "Asia/Tehran", null)).toBe("2026-08-17");
  });

  it("keeps a night service on one date for a branch whose day starts at 18:00", () => {
    const startMinutes = 18 * 60;
    // 20:00 and 01:00 Tehran are the same trading day for an 18:00 start.
    const evening = new Date("2026-08-16T16:30:00.000Z"); // 20:00 Tehran, 16th
    const afterMidnight = new Date("2026-08-16T21:30:00.000Z"); // 01:00 Tehran, 17th
    expect(businessDateOf(evening, "Asia/Tehran", startMinutes)).toBe("2026-08-16");
    expect(businessDateOf(afterMidnight, "Asia/Tehran", startMinutes)).toBe("2026-08-16");
  });

  it("rolls to the next trading day once the start time passes", () => {
    const startMinutes = 18 * 60;
    const nextEvening = new Date("2026-08-17T14:30:00.000Z"); // 18:00 Tehran, 17th
    expect(businessDateOf(nextEvening, "Asia/Tehran", startMinutes)).toBe("2026-08-17");
  });
});

describe("parseInstant", () => {
  it("rejects what Date would otherwise coerce", () => {
    expect(parseInstant("")).toBeNull();
    expect(parseInstant("   ")).toBeNull();
    expect(parseInstant(12345)).toBeNull();
    expect(parseInstant(null)).toBeNull();
    expect(parseInstant("not a date")).toBeNull();
    // A Jalali date pasted into the field: Date reads this as the year 1405.
    expect(parseInstant("1405/05/26")).toBeNull();
    // A plain date, or a local time with no offset, would be read in the
    // server's zone and could land on the wrong trading day.
    expect(parseInstant("2026-08-11")).toBeNull();
    expect(parseInstant("2026-08-11T19:30:00")).toBeNull();
  });

  it("accepts an ISO instant, with Z or an explicit offset", () => {
    expect(parseInstant("2026-08-11T19:30:00Z")?.toISOString()).toBe("2026-08-11T19:30:00.000Z");
    expect(parseInstant("2026-08-11T23:00:00+03:30")?.toISOString()).toBe("2026-08-11T19:30:00.000Z");
    expect(parseInstant("2026-08-11T19:30Z")?.toISOString()).toBe("2026-08-11T19:30:00.000Z");
  });
});

describe("instantInTimeZone", () => {
  it("reads the wall clock in the branch's zone, not the server's", () => {
    // 21:30 in Tehran (UTC+3:30) is 18:00 UTC.
    expect(instantInTimeZone("2026-08-11", "21:30", "Asia/Tehran")?.toISOString()).toBe(
      "2026-08-11T18:00:00.000Z",
    );
    // The same wall clock in a different branch is a different instant.
    expect(instantInTimeZone("2026-08-11", "21:30", "UTC")?.toISOString()).toBe(
      "2026-08-11T21:30:00.000Z",
    );
  });

  it("handles midnight and the end of the day", () => {
    expect(instantInTimeZone("2026-08-11", "00:00", "Asia/Tehran")?.toISOString()).toBe(
      "2026-08-10T20:30:00.000Z",
    );
    expect(instantInTimeZone("2026-08-11", "23:59", "Asia/Tehran")?.toISOString()).toBe(
      "2026-08-11T20:29:00.000Z",
    );
  });

  it("survives a zone that still observes DST, on both sides of the switch", () => {
    // Europe/Berlin: CET (+1) in January, CEST (+2) in July.
    expect(instantInTimeZone("2026-01-15", "12:00", "Europe/Berlin")?.toISOString()).toBe(
      "2026-01-15T11:00:00.000Z",
    );
    expect(instantInTimeZone("2026-07-15", "12:00", "Europe/Berlin")?.toISOString()).toBe(
      "2026-07-15T10:00:00.000Z",
    );
  });

  it("rejects a malformed day or time, and a day the calendar never had", () => {
    expect(instantInTimeZone("2026-8-11", "21:30", "Asia/Tehran")).toBeNull();
    expect(instantInTimeZone("2026-08-11", "9:30", "Asia/Tehran")).toBeNull();
    expect(instantInTimeZone("2026-08-11", "24:00", "Asia/Tehran")).toBeNull();
    expect(instantInTimeZone("2026-02-30", "12:00", "Asia/Tehran")).toBeNull();
    expect(instantInTimeZone("", "", "Asia/Tehran")).toBeNull();
  });
});

describe("validateBackdatedOrder with a day and a time", () => {
  it("resolves the pair in the branch's zone when no instant is given", () => {
    const result = validateBackdatedOrder(
      { ...input(), occurredAt: null, occurredOn: "2026-08-11", occurredTime: "21:30" },
      { now: NOW, timeZone: "Asia/Tehran" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.occurredAt.toISOString()).toBe("2026-08-11T18:00:00.000Z");
  });

  it("prefers an explicit instant over the pair", () => {
    const result = validateBackdatedOrder(
      { ...input(), occurredOn: "2026-07-01", occurredTime: "08:00" },
      { now: NOW, timeZone: "Asia/Tehran" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.occurredAt.toISOString()).toBe("2026-08-11T19:30:00.000Z");
  });

  it("rejects a pair that resolves to nothing", () => {
    expect(
      validateBackdatedOrder(
        { ...input(), occurredAt: null, occurredOn: "2026-08-11", occurredTime: "" },
        { now: NOW, timeZone: "Asia/Tehran" },
      ),
    ).toEqual({ ok: false, error: "invalid_occurred_at" });
  });
});
