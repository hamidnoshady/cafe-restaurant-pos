/**
 * Small numeric helpers shared by the billing services (wallet, plan builder).
 * Money is integer Rial everywhere.
 */

/** Coerce a possibly-null/string DB value to a finite non-negative integer. */
export function n(value: string | number | null | undefined): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

/** A strictly positive safe integer — the shape every Rial amount must have. */
export function positiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
