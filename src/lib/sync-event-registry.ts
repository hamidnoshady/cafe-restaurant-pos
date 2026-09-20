import type { Role } from "./auth";

export const SYNC_EVENT_REGISTRY_VERSION = 1 as const;

type LocationRule = "event_location" | "business_transfer";
type EffectClass = "order" | "payment" | "refund" | "journal_reversal" | "inventory" | "transfer";

export interface SyncEventDefinition {
  type: string;
  schemaVersion: number;
  handler: string;
  roles: readonly Role[];
  effectClass: EffectClass;
  locationRule: LocationRule;
  dependencyErrors: readonly string[];
  payloadFields: readonly string[];
  legacy?: boolean;
}

const ORDER_ROLES = ["owner", "manager", "cashier", "waiter"] as const;
const FINANCE_ROLES = ["owner", "manager", "cashier"] as const;
const INVENTORY_ROLES = ["owner", "manager"] as const;

/**
 * Authoritative, machine-readable sync event catalogue.
 *
 * There is no wildcard/version fallback: (type, schemaVersion) must match one
 * row exactly. This object drives route validation, dispatch, diagnostics and
 * catalogue tests, so those surfaces cannot silently drift apart.
 */
export const SYNC_EVENT_REGISTRY = [
  { type: "order.create", schemaVersion: 1, handler: "legacy.order.create", roles: ORDER_ROLES, effectClass: "order", locationRule: "event_location", dependencyErrors: [], payloadFields: ["type", "tableId", "customerId", "guestCount", "note", "discount", "items", "delivery"], legacy: true },
  { type: "order.add_items", schemaVersion: 1, handler: "legacy.order.add_items", roles: ORDER_ROLES, effectClass: "order", locationRule: "event_location", dependencyErrors: ["order_not_found"], payloadFields: ["orderId", "items"], legacy: true },
  { type: "order_item.status", schemaVersion: 1, handler: "legacy.order_item.status", roles: ORDER_ROLES, effectClass: "order", locationRule: "event_location", dependencyErrors: ["item_not_found"], payloadFields: ["itemId", "status"], legacy: true },

  { type: "order.payment.completed", schemaVersion: 1, handler: "order.payment.completed", roles: FINANCE_ROLES, effectClass: "payment", locationRule: "event_location", dependencyErrors: ["order_not_found", "order_not_open", "customer_not_found"], payloadFields: ["orderId", "method", "reference", "customerId", "tipAmount", "businessDate"] },
  { type: "order.customer_return.created", schemaVersion: 1, handler: "order.customer_return.created", roles: FINANCE_ROLES, effectClass: "refund", locationRule: "event_location", dependencyErrors: ["completed_order_not_found", "order_item_not_found", "historical_cogs_unavailable"], payloadFields: ["orderId", "refundMethod", "refundAmount", "reason", "lines"] },
  { type: "accounting.manual_journal.reversed", schemaVersion: 1, handler: "accounting.manual_journal.reversed", roles: ["owner", "manager"], effectClass: "journal_reversal", locationRule: "event_location", dependencyErrors: ["entry_not_found"], payloadFields: ["entryId", "memo", "entryDate"] },

  { type: "inventory.purchase.created", schemaVersion: 1, handler: "inventory.purchase.created", roles: INVENTORY_ROLES, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["supplier_not_found", "item_not_found"], payloadFields: ["supplierId", "note", "purchaseDate", "items"] },
  { type: "inventory.purchase.received", schemaVersion: 1, handler: "inventory.purchase.received", roles: INVENTORY_ROLES, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["purchase_not_found", "supplier_not_found"], payloadFields: ["purchaseId", "settlementMethod", "supplierId"] },
  { type: "inventory.supplier_return.created", schemaVersion: 1, handler: "inventory.supplier_return.created", roles: INVENTORY_ROLES, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["received_purchase_not_found", "supplier_return_purchase_item_not_found"], payloadFields: ["purchaseId", "settlementMethod", "reason", "lines"] },

  { type: "inventory.transfer.created", schemaVersion: 1, handler: "inventory.transfer.created", roles: INVENTORY_ROLES, effectClass: "transfer", locationRule: "business_transfer", dependencyErrors: ["transfer_inventory_item_not_found", "transfer_location_not_found"], payloadFields: ["destinationLocationId", "note", "lines"] },
  { type: "inventory.transfer.shipped", schemaVersion: 1, handler: "inventory.transfer.shipped", roles: INVENTORY_ROLES, effectClass: "transfer", locationRule: "business_transfer", dependencyErrors: ["transfer_not_found"], payloadFields: ["transferId"] },
  { type: "inventory.transfer.received", schemaVersion: 1, handler: "inventory.transfer.received", roles: INVENTORY_ROLES, effectClass: "transfer", locationRule: "business_transfer", dependencyErrors: ["transfer_not_found", "invalid_transfer_status"], payloadFields: ["transferId"] },
  { type: "inventory.transfer.cancelled", schemaVersion: 1, handler: "inventory.transfer.cancelled", roles: INVENTORY_ROLES, effectClass: "transfer", locationRule: "business_transfer", dependencyErrors: ["transfer_not_found"], payloadFields: ["transferId"] },

  { type: "inventory.waste.recorded", schemaVersion: 1, handler: "inventory.waste.recorded", roles: INVENTORY_ROLES, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["item_not_found"], payloadFields: ["inventoryItemId", "quantity", "reason", "note"] },
  { type: "inventory.stock_count.recorded", schemaVersion: 1, handler: "inventory.stock_count.recorded", roles: INVENTORY_ROLES, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["item_not_found"], payloadFields: ["note", "lines"] },
  { type: "inventory.stock_count.reversed", schemaVersion: 1, handler: "inventory.stock_count.reversed", roles: INVENTORY_ROLES, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["count_not_found"], payloadFields: ["countId", "note"] },
  { type: "retail.stock_count.recorded", schemaVersion: 1, handler: "retail.stock_count.recorded", roles: INVENTORY_ROLES, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["item_not_found"], payloadFields: ["note", "lines"] },
  { type: "retail.stock_count.reversed", schemaVersion: 1, handler: "retail.stock_count.reversed", roles: INVENTORY_ROLES, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["count_not_found"], payloadFields: ["countId", "note"] },
  { type: "inventory.production.recorded", schemaVersion: 1, handler: "inventory.production.recorded", roles: INVENTORY_ROLES, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["formula_not_found", "formula_inactive"], payloadFields: ["formulaId", "batches", "outputQuantity", "conversionCostRial", "note"] },
  { type: "inventory.production.reversed", schemaVersion: 1, handler: "inventory.production.reversed", roles: INVENTORY_ROLES, effectClass: "inventory", locationRule: "event_location", dependencyErrors: ["run_not_found"], payloadFields: ["runId", "note"] },
] as const satisfies readonly SyncEventDefinition[];

export type SyncEventType = (typeof SYNC_EVENT_REGISTRY)[number]["type"];

const byKey = new Map<string, SyncEventDefinition>(
  SYNC_EVENT_REGISTRY.map((entry) => [`${entry.type}@${entry.schemaVersion}`, entry]),
);

export function syncEventDefinition(type: unknown, schemaVersion: unknown): SyncEventDefinition | null {
  if (typeof type !== "string" || !Number.isSafeInteger(schemaVersion) || Number(schemaVersion) < 1) return null;
  return byKey.get(`${type}@${schemaVersion}`) ?? null;
}

export function isSyncEventType(type: unknown): type is SyncEventType {
  return typeof type === "string" && SYNC_EVENT_REGISTRY.some((entry) => entry.type === type);
}

export function publicSyncEventRegistry() {
  return {
    registryVersion: SYNC_EVENT_REGISTRY_VERSION,
    events: SYNC_EVENT_REGISTRY.map((entry: SyncEventDefinition) => ({
      type: entry.type,
      schemaVersion: entry.schemaVersion,
      roles: [...entry.roles],
      effectClass: entry.effectClass,
      locationRule: entry.locationRule,
      payloadFields: [...entry.payloadFields],
      transactionalDomainEffect: !entry.legacy,
    })),
  };
}
