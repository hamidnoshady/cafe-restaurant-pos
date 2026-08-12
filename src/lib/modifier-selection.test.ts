import { describe, expect, it } from "vitest";
import { DEFAULT_SELECTION_BOUNDS, resolveSelectionBounds } from "./modifier-selection";

const current = { min: 1, max: 3 };

describe("resolveSelectionBounds", () => {
  it("applies both bounds when both are sent", () => {
    expect(resolveSelectionBounds(DEFAULT_SELECTION_BOUNDS, { minSelect: 2, maxSelect: 4 })).toEqual({
      min: 2,
      max: 4,
    });
  });

  it("keeps the stored bound the caller omitted", () => {
    expect(resolveSelectionBounds(current, { minSelect: 3 })).toEqual({ min: 3, max: 3 });
    expect(resolveSelectionBounds(current, { maxSelect: 5 })).toEqual({ min: 1, max: 5 });
    expect(resolveSelectionBounds(current, {})).toEqual(current);
  });

  it("compares a partial update against the stored opposite bound", () => {
    // min alone may not overtake the stored max, nor max drop below the stored min.
    expect(resolveSelectionBounds(current, { minSelect: 4 })).toBeNull();
    expect(resolveSelectionBounds(current, { maxSelect: 0 })).toBeNull();
  });

  it("rejects min > max, negative min, and max < 1", () => {
    expect(resolveSelectionBounds(current, { minSelect: 3, maxSelect: 2 })).toBeNull();
    expect(resolveSelectionBounds(current, { minSelect: -5, maxSelect: 2 })).toBeNull();
    expect(resolveSelectionBounds(current, { minSelect: 0, maxSelect: 0 })).toBeNull();
  });

  it("rejects garbage instead of coercing it to a default", () => {
    for (const value of ["abc", "2", null, NaN, Infinity, 1.5, {}, []]) {
      expect(resolveSelectionBounds(current, { minSelect: value })).toBeNull();
      expect(resolveSelectionBounds(current, { maxSelect: value })).toBeNull();
    }
  });

  it("rejects a max beyond the int4 column", () => {
    expect(resolveSelectionBounds(current, { maxSelect: 2_147_483_647 })).toEqual({
      min: 1,
      max: 2_147_483_647,
    });
    expect(resolveSelectionBounds(current, { maxSelect: 2_147_483_648 })).toBeNull();
  });

  it("allows min == max, and 0/1 as the default group shape", () => {
    expect(resolveSelectionBounds(current, { minSelect: 2, maxSelect: 2 })).toEqual({ min: 2, max: 2 });
    expect(DEFAULT_SELECTION_BOUNDS).toEqual({ min: 0, max: 1 });
  });
});
