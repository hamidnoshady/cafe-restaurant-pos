import { describe, expect, it } from "vitest";
import { RECONCILABLE_ACCOUNTS, RECONCILABLE_ACCOUNT_CODES } from "./reconciliation-service";
import { RECONCILABLE_ACCOUNT_LABELS } from "./ai-labels";
import { WELL_KNOWN_CODES } from "./coa-template";

/**
 * The reconcilable set is duplicated in three places that must agree: the
 * service's own key list, the well-known codes it resolves to, and the Persian
 * labels the assistant hands back. It also has to include بانک — a cheque
 * clears into `1110` (Phase 30), and while this list was two entries long that
 * account had movements nobody could reconcile and its reconciliations would
 * have come back labelled as کارت‌خوان.
 */
describe("reconcilable accounts", () => {
  it("covers صندوق, بانک and کارت‌خوان", () => {
    expect([...RECONCILABLE_ACCOUNTS]).toEqual(["cash", "bank", "bankClearing"]);
  });

  it("resolves each key to its well-known code, with no two keys sharing one", () => {
    expect(RECONCILABLE_ACCOUNT_CODES.cash).toBe(WELL_KNOWN_CODES.cash);
    expect(RECONCILABLE_ACCOUNT_CODES.bank).toBe(WELL_KNOWN_CODES.bank);
    expect(RECONCILABLE_ACCOUNT_CODES.bankClearing).toBe(WELL_KNOWN_CODES.bankClearing);

    const codes = RECONCILABLE_ACCOUNTS.map((key) => RECONCILABLE_ACCOUNT_CODES[key]);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("has a Persian label for every key", () => {
    for (const key of RECONCILABLE_ACCOUNTS) {
      expect(RECONCILABLE_ACCOUNT_LABELS[key], key).toBeTruthy();
      expect(RECONCILABLE_ACCOUNT_LABELS[key]).not.toMatch(/[A-Za-z]/);
    }
  });
});
