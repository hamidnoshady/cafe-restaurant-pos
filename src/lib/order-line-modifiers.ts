/**
 * The one rule for "is this set of add-ons allowed on this menu item?".
 *
 * Every path that turns a submitted line into priced/persisted add-ons —
 * creating an order (`order-cart.ts`), adding items to an open order (same
 * resolver), re-picking the add-ons of a line already on an order
 * (`resolveLineModifiers`) — hands this function the rows it has already read
 * and gets the same verdict. The rule itself is pure, so it is unit-tested
 * rather than exercised only through the DB.
 *
 * The neighbouring modifier-selection.ts owns the other half of the same
 * subject — what a *group's* min/max bounds may be set to. This file is about
 * whether one line's chosen add-ons satisfy those bounds, *as resolved for
 * this item* (a group attached to two items can carry per-item overrides —
 * see `effectiveSelectionBounds`).
 */
import type { SelectionBounds } from "./modifier-selection";

/** A `modifiers` row, as every call site reads it. */
export interface SelectableModifier {
  id: string;
  group_id: string;
  name: string;
  price_delta: string | number;
  is_active: boolean;
}

/**
 * A modifier group *as it applies to one menu item*: the group's default
 * bounds already resolved through the item's own overrides. Building this is
 * the caller's job (one query per menu load); the rule stays pure.
 */
export interface AttachedModifierGroup {
  groupId: string;
  minSelect: number;
  maxSelect: number;
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
      error:
        | "invalid_modifier"
        | "duplicate_modifier"
        | "invalid_modifier_selection";
      status: 400;
    };

/**
 * A group's selection bounds for one item: the item's own override when it
 * has one, otherwise the group's default. This is what makes one shared
 * «نوع شیر» group required (1..1) on a latte but optional (0..1) on an
 * espresso without duplicating the group.
 */
export function effectiveSelectionBounds(
  groupDefaults: SelectionBounds,
  overrides: {
    minSelectOverride?: number | null;
    maxSelectOverride?: number | null;
  } | null | undefined,
): SelectionBounds {
  return {
    min:
      overrides && overrides.minSelectOverride != null
        ? overrides.minSelectOverride
        : groupDefaults.min,
    max:
      overrides && overrides.maxSelectOverride != null
        ? overrides.maxSelectOverride
        : groupDefaults.max,
  };
}

/**
 * Validates one line's add-ons and turns them into priced snapshots.
 *
 * Rejects with:
 *  - `duplicate_modifier` — the same add-on id submitted twice for one line.
 *    This is dangerous rather than merely sloppy: pricing would count the
 *    delta twice while the inventory snapshot's `ANY(uuid[])` lookup consumes
 *    its ingredients once, so money and stock would silently disagree. The
 *    same id twice is therefore always a malformed request, on every path
 *    (create, add-items, edit, offline replay).
 *  - `invalid_modifier` — an id that is unknown, malformed, inactive, or
 *    belongs to a group this menu item does not carry.
 *  - `invalid_modifier_selection` — a group's resolved [min, max] is not
 *    satisfied, including a required group the caller selected nothing from.
 *
 * Prices come from the `modifiers` rows, never from the client.
 */
export function resolveModifierSelection({
  modifierIds,
  modifiersById,
  attachedGroups,
}: {
  modifierIds: string[];
  modifiersById: Map<string, SelectableModifier>;
  /**
   * The modifier groups attached to this line's menu item, with each group's
   * bounds already resolved through the item's overrides. Groups the item does
   * not carry — or that are disabled — are simply absent, so an id from one of
   * them fails the attachment check below.
   */
  attachedGroups: Map<string, AttachedModifierGroup> | AttachedModifierGroup[];
}): ModifierSelectionResult {
  const attached =
    attachedGroups instanceof Map
      ? attachedGroups
      : new Map(attachedGroups.map((group) => [group.groupId, group]));

  // Duplicate ids are rejected before anything is priced: a repeated add-on is
  // never a legitimate configuration, and catching it here keeps the rule in
  // one place for every caller.
  const seen = new Set<string>();
  for (const modifierId of modifierIds) {
    if (seen.has(modifierId)) {
      return { ok: false, error: "duplicate_modifier", status: 400 };
    }
    seen.add(modifierId);
  }

  const selectedByGroup = new Map<string, number>();
  const modifiers: SelectedModifier[] = [];

  for (const modifierId of modifierIds) {
    const modifier = modifiersById.get(modifierId);
    if (
      !modifier ||
      !modifier.is_active ||
      !attached.has(modifier.group_id)
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

  // Every attached group is validated, not only the ones selected from — this
  // is what enforces a required group on a line submitted with no add-ons at
  // all. The attachment map must therefore always be built for the item,
  // whatever the request happened to contain.
  for (const [groupId, group] of attached) {
    const count = selectedByGroup.get(groupId) ?? 0;
    if (count < group.minSelect || count > group.maxSelect) {
      return { ok: false, error: "invalid_modifier_selection", status: 400 };
    }
  }

  return { ok: true, modifiers };
}
