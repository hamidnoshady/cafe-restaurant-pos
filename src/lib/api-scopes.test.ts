import { describe, expect, it } from "vitest";
import {
  ALL_API_SCOPES,
  API_SCOPES,
  hasApiScope,
  isApiScope,
  parseApiScopes,
  requireApiScope,
} from "./api-scopes";

describe("API scopes", () => {
  it("keeps the public capability catalogue explicit", () => {
    expect(ALL_API_SCOPES).toEqual([
      "orders.read",
      "orders.write",
      "menu.read",
      "menu.write",
      "inventory.read",
      "reports.read",
      "webhooks.manage",
    ]);
  });

  it("parses only known scopes and removes duplicates", () => {
    expect(
      parseApiScopes([API_SCOPES.ordersRead, "orders.read", "orders.delete", 42, null]),
    ).toEqual([API_SCOPES.ordersRead]);
  });

  it("fails closed for malformed or unknown stored scope values", () => {
    for (const value of [null, undefined, "orders.read", {}, ["future.scope"]]) {
      expect(parseApiScopes(value)).toEqual([]);
    }
    expect(isApiScope("orders.delete")).toBe(false);
  });

  it("allows only an explicitly granted scope", async () => {
    const scopes = [API_SCOPES.ordersRead];
    expect(hasApiScope(scopes, API_SCOPES.ordersRead)).toBe(true);
    expect(hasApiScope(scopes, API_SCOPES.ordersWrite)).toBe(false);

    const denied = requireApiScope(scopes, API_SCOPES.ordersWrite);
    expect(denied?.status).toBe(403);
    expect(await denied?.json()).toEqual({ error: "forbidden" });
    expect(requireApiScope(scopes, API_SCOPES.ordersRead)).toBeNull();
  });
});
