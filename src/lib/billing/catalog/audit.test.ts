import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditBillingCoverage, auditIsClean } from "./audit";
import { BILLING_DECLARATIONS } from "./declarations";

function apiSegments(): string[] {
  const root = join(process.cwd(), "src", "app", "api");
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function chargeKeys(): string[] {
  const keys = new Set<string>();
  const pattern = /chargeForFeature\(\s*[^,]+,\s*"([^"]+)"/g;
  for (const file of walk(join(process.cwd(), "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) keys.add(match[1]);
  }
  return [...keys].sort();
}

describe("billing declaration coverage", () => {
  it("matches every API segment, declaration and meter", () => {
    const report = auditBillingCoverage({ segments: apiSegments(), chargeKeys: chargeKeys() });
    expect(report.missingDeclarations).toEqual([]);
    expect(report.unknownMeters).toEqual([]);
    expect(report.unknownCapabilityReferences).toEqual([]);
    expect(report.orphanDeclarations).toEqual([]);
    expect(report.orphanMeters).toEqual([]);
    expect(report.unclassifiedSegments).toEqual([]);
    expect(report.staleSegments).toEqual([]);
    expect(auditIsClean(report)).toBe(true);
    expect(report.declarations).toBe(BILLING_DECLARATIONS.length);
    expect(report.platformActions).toBe(report.declarations > 0 ? report.platformActions : 0);
  });

  it("fails when a customer-facing capability has no declaration", () => {
    const report = auditBillingCoverage({
      segments: apiSegments(),
      chargeKeys: ["media.background_remove"],
    });
    expect(report.undeclaredChargeKeys).toContain("media.background_remove");
    expect(auditIsClean(report)).toBe(false);
  });
});
