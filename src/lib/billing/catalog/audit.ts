import { BILLING_DECLARATIONS, declarationMeterKeys } from "./declarations";
import { METER_CATALOGUE } from "./meters";
import { ROUTE_SEGMENT_BILLING } from "./routes";
import type { BillingDeclaration, MeterDefinition } from "./types";

export interface BillingAuditReport {
  platformActions: number;
  declarations: number;
  meters: number;
  missingDeclarations: string[];
  unknownMeters: string[];
  unknownCapabilityReferences: string[];
  orphanDeclarations: string[];
  orphanMeters: string[];
  unclassifiedSegments: string[];
  staleSegments: string[];
  undeclaredChargeKeys: string[];
}

/**
 * Compare the route inventory, the declaration registry, the meter catalogue
 * and the charge sites. Every list must be empty for CI to pass.
 */
export function auditBillingCoverage(input: {
  segments: readonly string[];
  chargeKeys: readonly string[];
  declarations?: readonly BillingDeclaration[];
  meters?: readonly MeterDefinition[];
  routes?: Record<string, { keys: string[] }>;
}): BillingAuditReport {
  const declarations = input.declarations ?? BILLING_DECLARATIONS;
  const meters = input.meters ?? METER_CATALOGUE;
  const routes = input.routes ?? ROUTE_SEGMENT_BILLING;
  const declared = new Set(declarations.map((row) => row.capabilityKey));
  const meterKeys = new Set(meters.map((meter) => meter.key));
  const referenced = new Set<string>();
  const referencedMeters = new Set<string>();

  for (const row of Object.values(routes)) {
    for (const key of row.keys) referenced.add(key);
  }
  for (const row of declarations) {
    for (const meterKey of declarationMeterKeys(row)) referencedMeters.add(meterKey);
  }

  const missingDeclarations = [...referenced].filter((key) => !declared.has(key)).sort();
  const unknownCapabilityReferences = input.chargeKeys.filter((key) => !declared.has(key)).sort();
  const unknownMeters = [...referencedMeters].filter((key) => !meterKeys.has(key)).sort();
  const orphanDeclarations = [...declared].filter((key) => !referenced.has(key)).sort();
  const orphanMeters = [...meterKeys].filter((key) => !referencedMeters.has(key)).sort();
  const disk = new Set(input.segments);
  const classified = new Set(Object.keys(routes));

  return {
    platformActions: input.segments.length,
    declarations: declarations.length,
    meters: meters.length,
    missingDeclarations,
    unknownMeters,
    unknownCapabilityReferences,
    orphanDeclarations,
    orphanMeters,
    unclassifiedSegments: [...disk].filter((segment) => !classified.has(segment)).sort(),
    staleSegments: [...classified].filter((segment) => !disk.has(segment)).sort(),
    undeclaredChargeKeys: unknownCapabilityReferences,
  };
}

export function auditIsClean(report: BillingAuditReport): boolean {
  return (
    report.missingDeclarations.length === 0 &&
    report.unknownMeters.length === 0 &&
    report.unknownCapabilityReferences.length === 0 &&
    report.orphanDeclarations.length === 0 &&
    report.orphanMeters.length === 0 &&
    report.unclassifiedSegments.length === 0 &&
    report.staleSegments.length === 0
  );
}
