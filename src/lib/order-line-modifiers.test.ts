import { describe, expect, it } from "vitest";
import {
  resolveModifierSelection,
  type ModifierGroupRule,
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

const GROUPS: ModifierGroupRule[] = [
  { id: "extras", min_select: 0, max_select: 2 },
  { id: "size", min_select: 1, max_select: 1 },
  { id: "sauces", min_select: 0, max_select: 1 },
];

function resolve(
  modifierIds: string[],
  allowed: string[] = ["extras", "size"],
) {
  return resolveModifierSelection({
    modifierIds,
    modifiersById: new Map(
      MODIFIERS.map((modifier) => [modifier.id, modifier]),
    ),
    allowedGroupIds: new Set(allowed),
    groupsById: new Map(GROUPS.map((group) => [group.id, group])),
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
      allowedGroupIds: new Set(["extras"]),
      groupsById: new Map([
        ["extras", { id: "extras", min_select: 0, max_select: 2 }],
      ]),
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
    expect(resolve(["bread"])).toEqual({
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

  it("ignores groups the item carries that have no rule row", () => {
    expect(
      resolve(["bread", "small"], ["extras", "size", "deleted-group"]),
    ).toMatchObject({
      ok: true,
    });
  });
});
