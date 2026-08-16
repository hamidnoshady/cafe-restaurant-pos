/**
 * The one rule for "is this set of add-ons allowed on this menu item?".
 *
 * Two call sites need it and must never disagree: resolving a cart line at
 * intake (order-cart.ts, which prices a whole cart in one batch of queries)
 * and re-picking the add-ons of a line that is already on an open order
 * (PATCH /api/orders/[id]/items/[itemId]). Both hand this function rows they
 * have already read; the rule itself is pure, so it is unit-tested rather
 * than exercised only through the DB.
 *
 * The neighbouring modifier-selection.ts owns the other half of the same
 * subject — what a *group's* min/max bounds may be set to. This file is about
 * whether one line's chosen add-ons satisfy those bounds.
 */

/** A `modifiers` row, as both call sites read it. */
export interface SelectableModifier {
  id: string;
  group_id: string;
  name: string;
  price_delta: string | number;
  is_active: boolean;
}

/** A `modifier_groups` row — only the two select limits matter here. */
export interface ModifierGroupRule {
  id: string;
  min_select: number;
  max_select: number;
}

/** What a validated selection turns into: the snapshot written to `order_item_modifiers`. */
export interface SelectedModifier {
  id: string;
  name: string;
  priceDelta: number;
}

export type ModifierSelectionResult =
  | { ok: true; modifiers: SelectedModifier[] }
  | {
      ok: false;
      error: "invalid_modifier" | "invalid_modifier_selection";
      status: 400;
    };

/**
 * Validates one line's add-ons and turns them into priced snapshots.
 *
 * Rejects with `invalid_modifier` when an id is unknown, inactive, or belongs
 * to a group this menu item does not carry, and with
 * `invalid_modifier_selection` when a group's min/max select is not satisfied
 * — including groups the caller selected nothing from, which is how a
 * required group is enforced.
 *
 * Prices come from the `modifiers` rows, never from the client.
 */
export function resolveModifierSelection({
  modifierIds,
  modifiersById,
  allowedGroupIds,
  groupsById,
}: {
  modifierIds: string[];
  modifiersById: Map<string, SelectableModifier>;
  /** The modifier groups attached to this line's menu item. */
  allowedGroupIds: Set<string>;
  groupsById: Map<string, ModifierGroupRule>;
}): ModifierSelectionResult {
  const selectedByGroup = new Map<string, number>();
  const modifiers: SelectedModifier[] = [];

  for (const modifierId of modifierIds) {
    const modifier = modifiersById.get(modifierId);
    if (
      !modifier ||
      !modifier.is_active ||
      !allowedGroupIds.has(modifier.group_id)
    ) {
      return { ok: false, error: "invalid_modifier", status: 400 };
    }
    selectedByGroup.set(
      modifier.group_id,
      (selectedByGroup.get(modifier.group_id) ?? 0) + 1,
    );
    modifiers.push({
      id: modifier.id,
      name: modifier.name,
      priceDelta: Number(modifier.price_delta),
    });
  }

  for (const groupId of allowedGroupIds) {
    const group = groupsById.get(groupId);
    if (!group) continue;
    const count = selectedByGroup.get(groupId) ?? 0;
    if (count < group.min_select || count > group.max_select) {
      return { ok: false, error: "invalid_modifier_selection", status: 400 };
    }
  }

  return { ok: true, modifiers };
}
