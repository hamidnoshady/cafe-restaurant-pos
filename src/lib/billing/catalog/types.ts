/**
 * Commercial vocabulary shared by the catalogue, the rating engine and CI.
 *
 * A customer-facing capability is never implicitly free. It declares one of
 * four modes; CI fails when a route segment, a charge site or a meter has
 * no matching declaration.
 */

export type BillingMode = "fixed" | "metered" | "hybrid" | "exempt";

export type BillingApplication = "accounting" | "growth" | "crm" | "website" | "platform";

export interface BillingDeclarationBase {
  capabilityKey: string;
  /** Persian name shown to operators and, when customerVisible, to the business. */
  name: string;
  application: BillingApplication;
  customerVisible: boolean;
  /** Critical capabilities keep running when a spend limit blocks the rest. */
  critical: boolean;
  /** When set, the entitlement resolver requires this permission of the acting user. */
  requiredPermission?: string;
}

export type BillingDeclaration =
  | (BillingDeclarationBase & { mode: "fixed" })
  | (BillingDeclarationBase & { mode: "metered"; meterKey: string; meterKeys?: string[] })
  | (BillingDeclarationBase & { mode: "hybrid"; meterKey: string; meterKeys?: string[] })
  | (BillingDeclarationBase & { mode: "exempt"; reason: string });

export type MeterAggregation = "sum" | "max" | "latest" | "average" | "byte_time" | "duration";

export type MeterSource = "platform" | "eshobe-cms" | "provider";

export interface MeterDefinition {
  key: string;
  name: string;
  description: string;
  unit: string;
  aggregation: MeterAggregation;
  /** How a billing period treats the quantity: reset, or keep the high-water mark. */
  billingPeriodBehavior: "reset" | "high_water";
  customerVisible: boolean;
  billable: boolean;
  active: boolean;
  source: MeterSource;
  critical: boolean;
}

/** A route segment bills as these declared capabilities (exempt declarations included). */
export interface RouteClass {
  keys: string[];
}
