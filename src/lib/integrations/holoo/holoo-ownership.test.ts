import { describe, expect, it } from "vitest";
import { holooGuardedEntityType, holooLocalIdFromPath } from "./holoo-ownership";

describe("holooGuardedEntityType", () => {
  it("maps a guarded prefix to its ownership entity type", () => {
    expect(holooGuardedEntityType("/api/parties")).toBe("holoo_customer");
    expect(holooGuardedEntityType("/api/parties/abc")).toBe("holoo_customer");
    expect(holooGuardedEntityType("/api/ledger/accounts")).toBe("holoo_account");
    expect(holooGuardedEntityType("/api/menu/items")).toBe("holoo_goods");
  });

  it("returns null for unguarded paths", () => {
    expect(holooGuardedEntityType("/api/orders")).toBeNull();
    expect(holooGuardedEntityType("/api/customering")).toBeNull();
  });
});

describe("holooLocalIdFromPath", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  it("extracts a uuid segment after the prefix", () => {
    expect(holooLocalIdFromPath(`/api/parties/${id}`, "/api/parties")).toBe(id);
    expect(holooLocalIdFromPath(`/api/menu/items/${id}/x`, "/api/menu/items")).toBe(id);
  });
  it("returns null when the segment is not a uuid", () => {
    expect(holooLocalIdFromPath("/api/parties", "/api/parties")).toBeNull();
    expect(holooLocalIdFromPath("/api/parties/not-a-uuid", "/api/parties")).toBeNull();
  });
});
