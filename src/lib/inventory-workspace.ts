/**
 * The model boundary behind the one public inventory workspace.
 *
 * `/accounting/inventory` is deliberately shared by every industry. Food
 * service keeps the `inventory_items` model and its inventory entitlement;
 * retail keeps the `items`/batch stock model and its stock module. Keeping the
 * decision here makes it impossible for either model to grow a second public
 * route merely to reach its own client panels.
 */
export const INVENTORY_WORKSPACE_MODELS = ["food-service", "retail"] as const;
export type InventoryWorkspaceModel =
  (typeof INVENTORY_WORKSPACE_MODELS)[number];

/** The industry profile's inventory module identifies the food-service model. */
export function inventoryWorkspaceModel(
  hasInventoryModule: boolean,
): InventoryWorkspaceModel {
  return hasInventoryModule ? "food-service" : "retail";
}

/** The module guard matching the selected model at the canonical page. */
export function inventoryModuleForWorkspace(
  model: InventoryWorkspaceModel,
): "inventory" | "stock" {
  return model === "food-service" ? "inventory" : "stock";
}
