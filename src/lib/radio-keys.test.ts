import { describe, expect, it } from "vitest";
import { radioMoveForKey, radioTargetIndex } from "./radio-keys";

describe("radioMoveForKey", () => {
  it("maps the vertical arrows the same way in every direction", () => {
    expect(radioMoveForKey("ArrowDown", true)).toBe("next");
    expect(radioMoveForKey("ArrowDown", false)).toBe("next");
    expect(radioMoveForKey("ArrowUp", true)).toBe("previous");
    expect(radioMoveForKey("ArrowUp", false)).toBe("previous");
  });

  it("swaps the horizontal arrows in RTL — next is to the left", () => {
    expect(radioMoveForKey("ArrowLeft", true)).toBe("next");
    expect(radioMoveForKey("ArrowRight", true)).toBe("previous");
    expect(radioMoveForKey("ArrowLeft", false)).toBe("previous");
    expect(radioMoveForKey("ArrowRight", false)).toBe("next");
  });

  it("maps Home and End to the ends", () => {
    expect(radioMoveForKey("Home", true)).toBe("first");
    expect(radioMoveForKey("End", true)).toBe("last");
  });

  it("ignores keys that are not radiogroup navigation", () => {
    for (const key of ["Enter", " ", "Tab", "a", "PageDown", ""]) {
      expect(radioMoveForKey(key, true)).toBeNull();
      expect(radioMoveForKey(key, false)).toBeNull();
    }
  });
});

describe("radioTargetIndex", () => {
  it("moves and wraps in both directions", () => {
    expect(radioTargetIndex("next", 0, 3)).toBe(1);
    expect(radioTargetIndex("next", 2, 3)).toBe(0);
    expect(radioTargetIndex("previous", 0, 3)).toBe(2);
    expect(radioTargetIndex("previous", 1, 3)).toBe(0);
  });

  it("jumps to the ends", () => {
    expect(radioTargetIndex("first", 2, 3)).toBe(0);
    expect(radioTargetIndex("last", 0, 3)).toBe(2);
  });

  it("has nowhere to move in a one-option group", () => {
    expect(radioTargetIndex("next", 0, 1)).toBeNull();
    expect(radioTargetIndex("previous", 0, 1)).toBeNull();
    // The ends are still well-defined: focusing the only option is a no-op,
    // but not an error.
    expect(radioTargetIndex("first", 0, 1)).toBe(0);
    expect(radioTargetIndex("last", 0, 1)).toBe(0);
  });

  it("refuses out-of-range input and empty groups", () => {
    expect(radioTargetIndex("next", 3, 3)).toBeNull();
    expect(radioTargetIndex("next", -1, 3)).toBeNull();
    expect(radioTargetIndex("next", 0, 0)).toBeNull();
  });
});
