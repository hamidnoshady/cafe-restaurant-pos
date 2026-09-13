import { describe, expect, it } from "vitest";
import {
  BRANCH_COLORS,
  DEFAULT_BRANCH_COLOR,
  branchColorLabel,
  branchColorStyle,
  isBranchColor,
  nextBranchColor,
  toBranchColor,
} from "./branch-color";

describe("isBranchColor / toBranchColor", () => {
  it("accepts exactly the palette the migration's CHECK allows", () => {
    for (const color of BRANCH_COLORS) expect(isBranchColor(color)).toBe(true);
  });

  it("rejects anything else, including a raw hex", () => {
    // The column stores a palette key, not a colour value — see 0149 for why.
    expect(isBranchColor("#ff0000")).toBe(false);
    expect(isBranchColor("blue")).toBe(false);
    expect(isBranchColor("")).toBe(false);
    expect(isBranchColor(null)).toBe(false);
    expect(isBranchColor(undefined)).toBe(false);
    expect(isBranchColor(7)).toBe(false);
  });

  it("falls back rather than leaving a control unpainted", () => {
    // A row written before 0149, or a body from an older client, still has to
    // render something.
    expect(toBranchColor(undefined)).toBe(DEFAULT_BRANCH_COLOR);
    expect(toBranchColor("chartreuse")).toBe(DEFAULT_BRANCH_COLOR);
    expect(toBranchColor("rose")).toBe("rose");
  });
});

describe("branchColorStyle", () => {
  it("gives every palette entry a full set of classes", () => {
    for (const color of BRANCH_COLORS) {
      const style = branchColorStyle(color);
      expect(style.label).toBeTruthy();
      for (const part of [style.dot, style.surface, style.bar, style.ring]) {
        expect(part).toBeTruthy();
        // Both themes, always: a value chosen for the light surface is
        // routinely unreadable on the dark one.
        expect(part).toContain("dark:");
      }
    }
  });

  it("writes class names out in full so Tailwind can see them", () => {
    // `bg-${color}-500` compiles to nothing — the classes must be literals.
    for (const color of BRANCH_COLORS) {
      expect(branchColorStyle(color).dot).toContain(`bg-${color}-`);
    }
  });

  it("gives each colour a distinct Persian name for the picker", () => {
    const labels = BRANCH_COLORS.map((color) => branchColorLabel(color));
    expect(new Set(labels).size).toBe(BRANCH_COLORS.length);
  });

  it("paints an unknown value with the fallback's style", () => {
    expect(branchColorStyle("nope")).toEqual(branchColorStyle(DEFAULT_BRANCH_COLOR));
  });
});

describe("palette ordering", () => {
  /**
   * Approximate oklch hue of each entry's 500 weight, read out of the
   * compiled Tailwind palette. Duplicated here rather than parsed from CSS
   * because the point is to pin the *ordering decision*, and a test that
   * recomputed the values from the same source it is checking would pass
   * whatever the order became.
   */
  const HUE: Record<string, number | null> = {
    slate: null, // near-achromatic (chroma 0.046) — reads as grey
    rose: 16.4,
    amber: 70.1,
    emerald: 162.5,
    sky: 237.3,
    violet: 292.7,
    teal: 182.5,
    orange: 47.6,
  };

  function minHueGap(colors: readonly string[]): number {
    const hues = colors.map((c) => HUE[c]).filter((h): h is number => h !== null);
    let min = 360;
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const raw = Math.abs(hues[i] - hues[j]);
        min = Math.min(min, Math.min(raw, 360 - raw));
      }
    }
    return min;
  }

  it("covers every palette entry", () => {
    for (const color of BRANCH_COLORS) expect(HUE).toHaveProperty(color);
  });

  it("keeps the first six branches far apart in hue", () => {
    // Most multi-branch businesses have a handful of branches, and they get
    // the head of this list. Reordering it alphabetically (the tempting
    // tidy-up) drops this to ~20° and makes emerald/teal adjacent at two
    // branches.
    expect(minHueGap(BRANCH_COLORS.slice(0, 6))).toBeGreaterThan(50);
  });

  it("starts with the neutral entry", () => {
    // A one-branch business should not be given an arbitrary colour implying
    // a distinction that does not exist; slate is also the column default.
    expect(BRANCH_COLORS[0]).toBe("slate");
    expect(DEFAULT_BRANCH_COLOR).toBe(BRANCH_COLORS[0]);
  });
});

describe("nextBranchColor", () => {
  it("gives the first branch the default", () => {
    expect(nextBranchColor([])).toBe(BRANCH_COLORS[0]);
  });

  it("never repeats a colour while unused ones remain", () => {
    // The whole point is that a business which never opens the picker still
    // ends up with branches it can tell apart.
    const taken: string[] = [];
    for (let i = 0; i < BRANCH_COLORS.length; i++) {
      const next = nextBranchColor(taken);
      expect(taken).not.toContain(next);
      taken.push(next);
    }
    expect(new Set(taken).size).toBe(BRANCH_COLORS.length);
  });

  it("fills a gap left by a deleted branch before wrapping", () => {
    const taken = BRANCH_COLORS.filter((color) => color !== "emerald");
    expect(nextBranchColor(taken)).toBe("emerald");
  });

  it("wraps instead of failing once the palette is exhausted", () => {
    // Eight distinguishable branches is past where colour alone identifies
    // anything; repeating beats refusing to create the branch.
    expect(BRANCH_COLORS).toContain(nextBranchColor([...BRANCH_COLORS]));
  });

  it("ignores junk among the taken values", () => {
    expect(nextBranchColor([null, "#abcdef", undefined, "slate"])).toBe(BRANCH_COLORS[1]);
  });
});
