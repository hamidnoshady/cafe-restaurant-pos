import { describe, expect, it } from "vitest";
import { validateInventoryCutoverManifest } from "./inventory-cutover";

const baseManifest = {
  locationId: "00000000-0000-0000-0000-000000000001",
  effectiveAt: "2026-07-24T00:00:00.000Z",
  approvedBy: "00000000-0000-0000-0000-000000000002",
  backupConfirmation: "backup-verified-20260724",
  evidenceSha256: "a".repeat(64),
  lines: [{
    inventoryItemId: "00000000-0000-0000-0000-000000000003",
    physicalQuantity: "0.333333333",
    carryingValueRial: "900719925474099312345",
    sourceClassification: "source_backed" as const,
  }],
};

describe("inventory cutover manifest", () => {
  it("requires backup evidence and manager/owner approval identifiers", () => {
    expect(() => validateInventoryCutoverManifest({ ...baseManifest, backupConfirmation: "" })).toThrow(
      "cutover_backup_confirmation_required",
    );
    expect(() => validateInventoryCutoverManifest({ ...baseManifest, approvedBy: "" })).toThrow(
      "cutover_approval_required",
    );
  });

  it("rejects excess quantity precision instead of rounding", () => {
    expect(() =>
      validateInventoryCutoverManifest({
        ...baseManifest,
        lines: [{ ...baseManifest.lines[0], physicalQuantity: "0.3333333333" }],
      }),
    ).toThrow("quantity_precision_exceeded");
  });

  it("produces a stable evidence-bound manifest hash", () => {
    const first = validateInventoryCutoverManifest(baseManifest);
    const second = validateInventoryCutoverManifest({ ...baseManifest, lines: [...baseManifest.lines] });
    expect(first.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.manifestSha256).toBe(first.manifestSha256);
  });
});
