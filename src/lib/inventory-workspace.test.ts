import { describe, expect, it } from "vitest";
import { ACCOUNTING_WORKSPACE_HREFS } from "./app-routes";
import {
  inventoryModuleForWorkspace,
  inventoryWorkspaceModel,
} from "./inventory-workspace";

describe("the unified inventory workspace", () => {
  it("keeps food service and retail behind the one canonical inventory door", () => {
    expect(ACCOUNTING_WORKSPACE_HREFS.inventory).toBe("/accounting/inventory");
    expect(inventoryWorkspaceModel(true)).toBe("food-service");
    expect(inventoryWorkspaceModel(false)).toBe("retail");
  });

  it("preserves each model's correct module guard without creating another route", () => {
    expect(inventoryModuleForWorkspace("food-service")).toBe("inventory");
    expect(inventoryModuleForWorkspace("retail")).toBe("stock");
  });
});
