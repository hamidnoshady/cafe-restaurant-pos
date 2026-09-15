import { describe, expect, it } from "vitest";
import {
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
  PIN_POLICY_HINT,
  isValidPin,
} from "./pin-policy";
import { isValidPin as reexportedFromTeam } from "./team";

/**
 * The PIN policy — the one rule both doors check.
 *
 * The shape is the backend's gate (the team and setup routes fold Persian
 * digits to Latin first, then call this), and since the client-side button
 * needs the same answer before a request leaves, the rule lives in this
 * client-safe module rather than in `team.ts` (which pulls in `node:crypto`).
 * What this file pins is that the two import paths agree, and that the shape
 * rule itself has no holes: lengths outside 4–12, non-digits, and the
 * un-folded Persian glyphs a caller forgot to normalise are all refused.
 */
describe("isValidPin", () => {
  it("accepts four digits — the legacy length every existing member holds", () => {
    expect(isValidPin("1234")).toBe(true);
    expect(isValidPin("0000")).toBe(true);
  });

  it("accepts longer PINs — Phase 42 opened the length up to twelve", () => {
    expect(isValidPin("123456")).toBe(true);
    expect(isValidPin("12345678")).toBe(true);
    expect(isValidPin("123456789012")).toBe(true);
  });

  it("rejects anything else", () => {
    for (const pin of ["123", "1234567890123", "12a4", "", " 1234", "۱۲۳۴"]) {
      expect(isValidPin(pin), pin).toBe(false);
    }
  });

  it("is the same rule team.ts re-exports for its server callers", () => {
    // team.ts re-exports the policy so its existing importers keep working;
    // a second definition smuggled back in would fork the door and the pad.
    expect(reexportedFromTeam).toBe(isValidPin);
  });

  it("publishes the bounds and a hint that name them", () => {
    expect(PIN_MIN_LENGTH).toBe(4);
    expect(PIN_MAX_LENGTH).toBe(12);
    expect(PIN_POLICY_HINT).toContain("۴");
    expect(PIN_POLICY_HINT).toContain("۱۲");
  });
});
