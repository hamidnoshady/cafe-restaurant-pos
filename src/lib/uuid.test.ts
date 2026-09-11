import { describe, expect, it } from "vitest";
import { isUuid } from "./uuid";
import { UNKNOWN_CUSTOMER_KEY } from "./aging";
import { UNKNOWN_SUPPLIER_KEY } from "./ap-service";

describe("isUuid", () => {
  it("accepts a Postgres uuid in either case", () => {
    expect(isUuid("3f8c1c2e-0f1a-4b6d-8b2f-9a1c2d3e4f50")).toBe(true);
    expect(isUuid("3F8C1C2E-0F1A-4B6D-8B2F-9A1C2D3E4F50")).toBe(true);
  });

  it("rejects the A/R and A/P sentinel ids that used to reach a uuid column", () => {
    // Handing either of these to `WHERE id = $1` raises a Postgres syntax
    // error, not an empty result — which is why the pickers filter them and the
    // services check before querying.
    expect(isUuid(UNKNOWN_CUSTOMER_KEY)).toBe(false);
    expect(isUuid(UNKNOWN_SUPPLIER_KEY)).toBe(false);
  });

  it("rejects anything else", () => {
    for (const value of ["", "  ", "not-a-uuid", "1234", null, undefined, 7, {}]) {
      expect(isUuid(value)).toBe(false);
    }
  });
});
