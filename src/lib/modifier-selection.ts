/**
 * How many modifiers a group requires and allows.
 *
 * These bounds are load-bearing at the point of sale: buildCart() in
 * order-cart.ts rejects an order whose selected count for a group falls outside
 * [min_select, max_select], so a group stored with min > max makes every order
 * containing an item linked to it fail with invalid_modifier_selection, and
 * modifier-picker.tsx's confirm button can never enable.
 */
export interface SelectionBounds {
  min: number;
  max: number;
}

/** Both bounds are backed by an int4 column. */
const INT4_MAX = 2_147_483_647;

/** A new group is optional and single-choice until told otherwise. */
export const DEFAULT_SELECTION_BOUNDS: SelectionBounds = { min: 0, max: 1 };

function bound(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * Resolves what a group's bounds become after a create or a patch, or null when
 * the result would be invalid.
 *
 * An absent side falls back to `current`, which is what makes this safe for a
 * partial update: patching only `minSelect` still checks it against the group's
 * *stored* `max_select` rather than against a default. A present-but-not-integer
 * value is rejected rather than coerced to the fallback — silently storing a
 * default in place of a caller's garbage is how a group ends up unorderable.
 */
export function resolveSelectionBounds(
  current: SelectionBounds,
  patch: { minSelect?: unknown; maxSelect?: unknown },
): SelectionBounds | null {
  const min = bound(patch.minSelect, current.min);
  const max = bound(patch.maxSelect, current.max);
  if (min === null || max === null) return null;
  if (min < 0 || max < 1 || min > max || max > INT4_MAX) return null;
  return { min, max };
}
