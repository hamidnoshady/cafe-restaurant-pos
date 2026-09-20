import { describe, expect, it } from "vitest";
import {
  effectiveSelectionBounds,
  resolveModifierSelection,
  type AttachedModifierGroup,
  type SelectableModifier,
} from "./order-line-modifiers";

/** «نان» and «لیمو» from an optional group, «کوچک»/«بزرگ» from a required one. */
const MODIFIERS: SelectableModifier[] = [
  {
    id: "bread",
    group_id: "extras",
    name: "نان",
    price_delta: 300_000,
    is_active: true,
  },
  {
    id: "lemon",
    group_id: "extras",
    name: "لیمو",
    price_delta: 100_000,
    is_active: true,
  },
  {
    id: "retired",
    group_id: "extras",
    name: "سس قدیمی",
    price_delta: 50_000,
    is_active: false,
  },
  {
    id: "small",
    group_id: "size",
    name: "کوچک",
    price_delta: 0,
    is_active: true,
  },
  {
    id: "large",
    group_id: "size",
    name: "بزرگ",
    price_delta: 400_000,
    is_active: true,
  },
  {
    id: "foreign",
    group_id: "sauces",
    name: "سس دیگر",
    price_delta: 20_000,
    is_active: true,
  },
];

/** Group defaults, as the loader reads them from `modifier_groups`. */
const GROUP_DEFAULTS: Record<string, { min: number; max: number }> = {
  extras: { min: 0, max: 2 },
  size: { min: 1, max: 1 },
  sauces: { min: 0, max: 1 },
};

/**
 * Builds the attachment map exactly the way order-cart.ts does: the item's
 * attached groups with bounds resolved item-override → group default.
 */
function attachments(
  allowed: string[],
  overrides: Record<string, { minSelectOverride?: number | null; maxSelectOverride?: number | null }> = {},
): Map<string, AttachedModifierGroup> {
  return new Map(
    allowed.map((groupId) => {
      const bounds = effectiveSelectionBounds(GROUP_DEFAULTS[groupId], overrides[groupId]);
      return [groupId, { groupId, minSelect: bounds.min, maxSelect: bounds.max }];
    }),
  );
}

function resolve(
  modifierIds: string[],
  allowed: string[] = ["extras", "size"],
  overrides: Record<string, { minSelectOverride?: number | null; maxSelectOverride?: number | null }> = {},
) {
  return resolveModifierSelection({
    modifierIds,
    modifiersById: new Map(
      MODIFIERS.map((modifier) => [modifier.id, modifier]),
    ),
    attachedGroups: attachments(allowed, overrides),
  });
}

describe("resolveModifierSelection", () => {
  it("prices the selection from the modifier rows, not the caller", () => {
    const result = resolve(["bread", "small"]);
    expect(result).toEqual({
      ok: true,
      modifiers: [
        { id: "bread", name: "نان", priceDelta: 300_000 },
        { id: "small", name: "کوچک", priceDelta: 0 },
      ],
    });
  });

  it("parses text price deltas, as pg returns bigint columns", () => {
    const result = resolveModifierSelection({
      modifierIds: ["bread"],
      modifiersById: new Map([
        [
          "bread",
          {
            id: "bread",
            group_id: "extras",
            name: "نان",
            price_delta: "300000",
            is_active: true,
          },
        ],
      ]),
      attachedGroups: attachments(["extras"]),
    });
    expect(result).toEqual({
      ok: true,
      modifiers: [{ id: "bread", name: "نان", priceDelta: 300_000 }],
    });
  });

  it("accepts an empty selection when no group is required", () => {
    expect(resolve([], ["extras"])).toEqual({ ok: true, modifiers: [] });
  });

  it("rejects an unknown modifier id", () => {
    expect(resolve(["nope", "small"])).toEqual({
      ok: false,
      error: "invalid_modifier",
      status: 400,
    });
  });

  it("rejects an inactive modifier", () => {
    expect(resolve(["retired", "small"])).toEqual({
      ok: false,
      error: "invalid_modifier",
      status: 400,
    });
  });

  it("rejects a modifier from a group this item does not carry", () => {
    expect(resolve(["foreign", "small"])).toEqual({
      ok: false,
      error: "invalid_modifier",
      status: 400,
    });
  });

  it("rejects a required group nothing was selected from", () => {
    // This is the required-modifier bypass: the attachment map must be built
    // for the item whether or not the request carried any modifier ids, and a
    // required «اندازه» 1..1 group must refuse an empty selection.
    expect(resolve(["bread"])).toEqual({
      ok: false,
      error: "invalid_modifier_selection",
      status: 400,
    });
  });

  it("rejects a required group on a line submitted with no modifiers at all", () => {
    // The regression case from order-cart.ts: modifierIds: [] used to skip
    // loading the groups entirely, so the rule never ran. With the map always
    // present, an empty selection fails the same way.
    expect(resolve([], ["extras", "size"])).toEqual({
      ok: false,
      error: "invalid_modifier_selection",
      status: 400,
    });
  });

  it("rejects more selections than a group's max_select", () => {
    expect(resolve(["small", "large"])).toEqual({
      ok: false,
      error: "invalid_modifier_selection",
      status: 400,
    });
  });

  it("rejects too few selections for a multi-min group", () => {
    // One «نان» against an item-level min of 2 on «افزودنی». (A selection
    // naming a modifier from an *unattached* group would fail earlier, as
    // invalid_modifier — the previous version of this case mixed the two.)
    expect(resolve(["bread"], ["extras"], { extras: { minSelectOverride: 2 } })).toEqual({
      ok: false,
      error: "invalid_modifier_selection",
      status: 400,
    });
  });

  it("rejects a duplicate modifier id before anything is priced", () => {
    // Pricing would count the delta twice while the inventory snapshot's
    // ANY(uuid[]) lookup consumes ingredients once — never a valid line.
    expect(resolve(["bread", "bread", "small"])).toEqual({
      ok: false,
      error: "duplicate_modifier",
      status: 400,
    });
    expect(resolve(["small", "small"])).toEqual({
      ok: false,
      error: "duplicate_modifier",
      status: 400,
    });
  });

  it("applies per-item overrides on top of the group's defaults", () => {
    // «نوع شیر» required on the latte, optional on the espresso: same group,
    // two resolved rules — the override decides, the default fills the gaps.
    const latte = resolveModifierSelection({
      modifierIds: [],
      modifiersById: new Map(MODIFIERS.map((m) => [m.id, m])),
      attachedGroups: attachments(["extras"], { extras: { minSelectOverride: 1 } }),
    });
    expect(latte).toEqual({ ok: false, error: "invalid_modifier_selection", status: 400 });

    const espresso = resolveModifierSelection({
      modifierIds: [],
      modifiersById: new Map(MODIFIERS.map((m) => [m.id, m])),
      attachedGroups: attachments(["extras"], { extras: { minSelectOverride: 0, maxSelectOverride: 1 } }),
    });
    expect(espresso).toEqual({ ok: true, modifiers: [] });
  });

  it("accepts an attachment list as well as a map", () => {
    expect(
      resolveModifierSelection({
        modifierIds: ["small"],
        modifiersById: new Map(MODIFIERS.map((m) => [m.id, m])),
        attachedGroups: [{ groupId: "size", minSelect: 1, maxSelect: 1 }],
      }),
    ).toMatchObject({ ok: true });
  });
});

describe("effectiveSelectionBounds", () => {
  it("falls back to the group defaults when no override is set", () => {
    expect(effectiveSelectionBounds({ min: 1, max: 3 }, undefined)).toEqual({ min: 1, max: 3 });
    expect(effectiveSelectionBounds({ min: 1, max: 3 }, { minSelectOverride: null, maxSelectOverride: null })).toEqual({
      min: 1,
      max: 3,
    });
  });

  it("overrides only the side that is set", () => {
    expect(effectiveSelectionBounds({ min: 0, max: 2 }, { minSelectOverride: 1 })).toEqual({ min: 1, max: 2 });
    expect(effectiveSelectionBounds({ min: 0, max: 1 }, { maxSelectOverride: 3 })).toEqual({ min: 0, max: 3 });
  });
});
