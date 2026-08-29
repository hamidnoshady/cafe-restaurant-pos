import { describe, expect, it } from "vitest";
import {
  PRODUCT_UPDATE_FIELDS,
  sanitizeOrderStatus,
  sanitizeProductPatch,
  sanitizeRefund,
  WooOpsError,
} from "./woo-ops-service";

/**
 * The shape of what this channel is willing to write to a live shopfront.
 * Everything else in the module needs a database; these rules are the part
 * that has to be right before anything is queued, and they are pure.
 */
describe("sanitizeProductPatch", () => {
  it("passes through the fields it allows", () => {
    expect(
      sanitizeProductPatch({
        name: "چای دم‌نوش",
        regular_price: "15000",
        sale_price: "12000",
        stock_quantity: 4,
        manage_stock: true,
        status: "publish",
      }),
    ).toEqual({
      name: "چای دم‌نوش",
      regular_price: "15000",
      sale_price: "12000",
      stock_quantity: 4,
      manage_stock: true,
      status: "publish",
    });
  });

  it("drops the fields that would restructure the catalogue", () => {
    // type / parent_id / sku / attributes / categories are all writable over
    // REST and all refused here: one mis-sent `type` orphans every variation.
    const patch = sanitizeProductPatch({
      name: "تی‌شرت",
      type: "variable",
      parent_id: 0,
      sku: "TS-BLK",
      attributes: [{ id: 1 }],
    });
    expect(patch).toEqual({ name: "تی‌شرت" });
    for (const blocked of ["type", "parent_id", "sku", "attributes"]) {
      expect(PRODUCT_UPDATE_FIELDS as readonly string[]).not.toContain(blocked);
    }
  });

  it("ignores unknown keys instead of rejecting the whole patch", () => {
    // The dashboard is allowed to send a fuller object; silently dropping
    // what we will not write is safer than losing a legitimate price change.
    expect(sanitizeProductPatch({ regular_price: "99000", something_else: "x" })).toEqual({
      regular_price: "99000",
    });
  });

  it("skips null and undefined rather than clearing a field by accident", () => {
    expect(sanitizeProductPatch({ name: "تی‌شرت", description: null, sale_price: undefined })).toEqual({
      name: "تی‌شرت",
    });
  });

  it("refuses an empty patch — there is nothing to send", () => {
    expect(() => sanitizeProductPatch({ type: "simple" })).toThrow(WooOpsError);
    expect(() => sanitizeProductPatch({})).toThrow(WooOpsError);
  });

  it("floors a fractional stock quantity and rejects a negative one", () => {
    expect(sanitizeProductPatch({ stock_quantity: 3.7 }).stock_quantity).toBe(3);
    expect(() => sanitizeProductPatch({ stock_quantity: -1 })).toThrow(WooOpsError);
    expect(() => sanitizeProductPatch({ stock_quantity: "many" })).toThrow(WooOpsError);
  });

  it("keeps prices as strings so a float cannot round an owner's amount", () => {
    // WooCommerce rejects a JSON number for price, and 15000.5 as a float
    // would move money the owner never typed.
    expect(sanitizeProductPatch({ regular_price: 15000 }).regular_price).toBe("15000");
    expect(sanitizeProductPatch({ sale_price: "0" }).sale_price).toBe("0");
    expect(() => sanitizeProductPatch({ regular_price: "15,000" })).toThrow(WooOpsError);
    expect(() => sanitizeProductPatch({ regular_price: "free" })).toThrow(WooOpsError);
  });

  it("accepts an empty sale price, which is how a sale is ended", () => {
    expect(sanitizeProductPatch({ sale_price: "" }).sale_price).toBe("");
  });

  it("restricts product status to WooCommerce's own four", () => {
    expect(sanitizeProductPatch({ status: "draft" }).status).toBe("draft");
    expect(() => sanitizeProductPatch({ status: "completed" })).toThrow(WooOpsError);
  });

  it("coerces manage_stock to a boolean, so a string 'false' is false", () => {
    expect(sanitizeProductPatch({ manage_stock: "false" }).manage_stock).toBe(true);
    expect(sanitizeProductPatch({ manage_stock: 0 }).manage_stock).toBe(false);
  });
});

describe("sanitizeOrderStatus", () => {
  it("accepts each of WooCommerce's canonical statuses", () => {
    for (const status of ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"]) {
      expect(sanitizeOrderStatus(status)).toBe(status);
    }
  });

  it("rejects anything else, including a plausible invention", () => {
    expect(() => sanitizeOrderStatus("shipped")).toThrow(WooOpsError);
    expect(() => sanitizeOrderStatus("Completed")).toThrow(WooOpsError);
    expect(() => sanitizeOrderStatus("")).toThrow(WooOpsError);
  });
});

describe("sanitizeRefund", () => {
  it("normalises the amount and the optional reason", () => {
    expect(sanitizeRefund({ amount: " 25000 ", reason: "  مرجوعی مشتری  " })).toEqual({
      amount: "25000",
      reason: "مرجوعی مشتری",
      api_refund: false,
    });
  });

  it("never asks the gateway to move money", () => {
    // Forced false even when a caller begs: refunding on a card is
    // irreversible and happens on someone else's money.
    expect(sanitizeRefund({ amount: "1", api_refund: true as never }).api_refund).toBe(false);
  });

  it("rejects an amount that is not a positive decimal", () => {
    for (const amount of ["", "0", "-500", "1,000", "abc", undefined]) {
      expect(() => sanitizeRefund({ amount } as Record<string, unknown>)).toThrow(WooOpsError);
    }
    expect(sanitizeRefund({ amount: "0.5" }).amount).toBe("0.5");
  });

  it("caps a runaway reason so the payload stays writable", () => {
    const reason = "ب".repeat(900);
    expect(sanitizeRefund({ amount: "1", reason }).reason).toHaveLength(500);
  });
});
