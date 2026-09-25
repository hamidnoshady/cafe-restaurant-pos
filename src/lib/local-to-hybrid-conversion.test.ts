import { describe, expect, it } from "vitest";
import { conversionExport } from "../../scripts/convert-local-to-hybrid";

describe("Local to Hybrid conversion export", () => {
  it("excludes device-local tables and settings without dropping operational data", () => {
    const result = conversionExport([
      { name: "orders", columns: ["id"], rows: [{ id: "order-1" }] },
      { name: "printers", columns: ["id"], rows: [{ id: "printer-1" }] },
      { name: "cloud_exception_outbox", columns: ["event_id"], rows: [{ event_id: "event-1" }] },
      { name: "settings", columns: ["key", "value"], rows: [
        { key: "backup.config", value: { path: "C:/private" } },
        { key: "server_sync.config", value: { token: "secret" } },
        { key: "tax.config", value: { defaultRate: 10 } },
      ] },
    ]);
    expect(result.map((table) => table.name)).toEqual(["orders", "settings"]);
    expect(result[1].rows).toEqual([{ key: "tax.config", value: { defaultRate: 10 } }]);
  });
});
