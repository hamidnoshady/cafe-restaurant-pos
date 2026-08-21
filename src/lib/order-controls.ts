import type { Role } from "./auth";

export interface OrderControlPolicy {
  cashierDiscountLimitPercent: number;
  wholeOrderVoidRequiresManager: boolean;
  postKitchenChangeRequiresManager: boolean;
}

export const DEFAULT_ORDER_CONTROL_POLICY: OrderControlPolicy = {
  cashierDiscountLimitPercent: 10,
  wholeOrderVoidRequiresManager: true,
  postKitchenChangeRequiresManager: true,
};

export type ControlledOrderAction = "discount" | "order_void" | "item_quantity" | "item_void" | "add_items";

export interface OrderControlRequest {
  policy: OrderControlPolicy;
  actorRole: Role;
  action: ControlledOrderAction;
  discountPercent?: number;
  kitchenStarted: boolean;
}

export function normalizeVoidReason(reason: unknown): string {
  const normalized = typeof reason === "string" ? reason.trim() : "";
  if (!normalized) throw Object.assign(new Error("void_reason_required"), { code: "void_reason_required", status: 400 });
  return normalized;
}

export function isManagerRole(role: Role): boolean {
  return role === "owner" || role === "manager";
}

export function assertOrderControl(request: OrderControlRequest): void {
  if (isManagerRole(request.actorRole)) return;
  const { policy, action } = request;
  const needsManager =
    (action === "discount" &&
      Number(request.discountPercent ?? 0) > policy.cashierDiscountLimitPercent) ||
    (action === "order_void" && policy.wholeOrderVoidRequiresManager) ||
    (request.kitchenStarted &&
      policy.postKitchenChangeRequiresManager &&
      (action === "add_items" || action === "item_quantity" || action === "item_void"));
  if (needsManager) {
    throw Object.assign(new Error("manager_approval_required"), {
      code: "manager_approval_required",
      status: 403,
    });
  }
}

export function parseOrderControlPolicy(value: unknown): OrderControlPolicy {
  if (!value || typeof value !== "object") return DEFAULT_ORDER_CONTROL_POLICY;
  const input = value as Partial<OrderControlPolicy>;
  const limit = Number(input.cashierDiscountLimitPercent);
  return {
    cashierDiscountLimitPercent:
      Number.isFinite(limit) && limit >= 0 && limit <= 100
        ? limit
        : DEFAULT_ORDER_CONTROL_POLICY.cashierDiscountLimitPercent,
    wholeOrderVoidRequiresManager:
      typeof input.wholeOrderVoidRequiresManager === "boolean"
        ? input.wholeOrderVoidRequiresManager
        : DEFAULT_ORDER_CONTROL_POLICY.wholeOrderVoidRequiresManager,
    postKitchenChangeRequiresManager:
      typeof input.postKitchenChangeRequiresManager === "boolean"
        ? input.postKitchenChangeRequiresManager
        : DEFAULT_ORDER_CONTROL_POLICY.postKitchenChangeRequiresManager,
  };
}
