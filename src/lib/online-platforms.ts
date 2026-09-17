export const MAX_ONLINE_PLATFORM_COMMISSION_PERCENT = 100;

/** The percentage range a platform contract can use. */
export function validCommissionPercent(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_ONLINE_PLATFORM_COMMISSION_PERCENT
  );
}
