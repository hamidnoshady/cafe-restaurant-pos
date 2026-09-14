import { describe, expect, it } from "vitest";
import { ACCOUNTING_WORKSPACE_HREFS } from "./app-routes";
import { INDUSTRY_PROFILES, hasModule } from "./industry-profile";
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

  it("uses the food-service guard for F&B and the stock guard for every retail industry", () => {
    for (const industry of Object.keys(INDUSTRY_PROFILES)) {
      const model = inventoryWorkspaceModel(
        hasModule(industry as keyof typeof INDUSTRY_PROFILES, "inventory"),
      );
      if (industry === "food_service") {
        expect(model).toBe("food-service");
        expect(inventoryModuleForWorkspace(model)).toBe("inventory");
      } else {
        expect(model, industry).toBe("retail");
        expect(inventoryModuleForWorkspace(model), industry).toBe("stock");
      }
    }
  });
});
