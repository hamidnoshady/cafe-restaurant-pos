/** Explicit data authority and conflict policy for synchronized domains. */
export type DataOwnership = "site_authoritative" | "cloud_authoritative" | "shared_synchronized" | "device_local";
export type SyncDirection = "site_to_cloud" | "cloud_to_site" | "bidirectional" | "none";
export type ConflictPolicy =
  | "immutable_idempotent"
  | "append_only"
  | "append_or_reverse"
  | "field_merge_with_version"
  | "authoritative_scope"
  | "never_sync";

export interface DomainOwnershipDefinition {
  domain: string;
  ownership: DataOwnership;
  direction: SyncDirection;
  conflictPolicy: ConflictPolicy;
  deletion: "tombstone" | "archive" | "authoritative_delete" | "not_applicable";
  bootstrap: "required" | "optional" | "none";
}

export const DATA_OWNERSHIP_REGISTRY = {
  orders: { domain: "orders", ownership: "site_authoritative", direction: "site_to_cloud", conflictPolicy: "immutable_idempotent", deletion: "archive", bootstrap: "optional" },
  payments: { domain: "payments", ownership: "site_authoritative", direction: "site_to_cloud", conflictPolicy: "append_only", deletion: "not_applicable", bootstrap: "optional" },
  accounting_journals: { domain: "accounting_journals", ownership: "site_authoritative", direction: "site_to_cloud", conflictPolicy: "append_or_reverse", deletion: "not_applicable", bootstrap: "optional" },
  inventory_movements: { domain: "inventory_movements", ownership: "site_authoritative", direction: "site_to_cloud", conflictPolicy: "append_only", deletion: "not_applicable", bootstrap: "optional" },
  customers: { domain: "customers", ownership: "shared_synchronized", direction: "bidirectional", conflictPolicy: "field_merge_with_version", deletion: "tombstone", bootstrap: "required" },
  products_menu: { domain: "products_menu", ownership: "shared_synchronized", direction: "bidirectional", conflictPolicy: "authoritative_scope", deletion: "tombstone", bootstrap: "required" },
  staff_access: { domain: "staff_access", ownership: "shared_synchronized", direction: "cloud_to_site", conflictPolicy: "authoritative_scope", deletion: "tombstone", bootstrap: "required" },
  plans_billing: { domain: "plans_billing", ownership: "cloud_authoritative", direction: "cloud_to_site", conflictPolicy: "authoritative_scope", deletion: "authoritative_delete", bootstrap: "optional" },
  printer_settings: { domain: "printer_settings", ownership: "device_local", direction: "none", conflictPolicy: "never_sync", deletion: "not_applicable", bootstrap: "none" },
  backup_paths: { domain: "backup_paths", ownership: "device_local", direction: "none", conflictPolicy: "never_sync", deletion: "not_applicable", bootstrap: "none" },
  lan_gateway: { domain: "lan_gateway", ownership: "device_local", direction: "none", conflictPolicy: "never_sync", deletion: "not_applicable", bootstrap: "none" },
} as const satisfies Record<string, DomainOwnershipDefinition>;

export type DataDomain = keyof typeof DATA_OWNERSHIP_REGISTRY;
export function ownershipFor(domain: DataDomain): DomainOwnershipDefinition {
  return DATA_OWNERSHIP_REGISTRY[domain];
}
