import { describe, expect, it } from "vitest";
import { DATA_OWNERSHIP_REGISTRY, ownershipFor } from "./data-ownership";

describe("data ownership registry", () => {
  it("never gives financial or inventory events timestamp overwrite semantics", () => {
    for (const domain of ["payments", "accounting_journals", "inventory_movements"] as const) {
      expect(["append_only", "append_or_reverse"]).toContain(ownershipFor(domain).conflictPolicy);
    }
  });
  it("keeps filesystem and printer configuration device-local", () => {
    for (const domain of ["printer_settings", "backup_paths", "lan_gateway", "certificate_paths", "database_paths", "cloud_exception_transport"] as const) {
      expect(DATA_OWNERSHIP_REGISTRY[domain]).toMatchObject({ ownership: "device_local", direction: "none", conflictPolicy: "never_sync" });
    }
  });
});
