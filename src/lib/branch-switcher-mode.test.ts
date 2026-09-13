import { describe, expect, it } from "vitest";
import { branchSwitcherMode } from "./branch-switcher-mode";

describe("branchSwitcherMode", () => {
  it("gives a switchable member the full menu", () => {
    expect(
      branchSwitcherMode({ canSwitch: true, businessLocationCount: 3, accessibleCount: 3 }),
    ).toBe("menu");
  });

  it("shows nothing at all to a single-branch business", () => {
    // The regression this function exists to prevent: one branch, nowhere to
    // go, no question to answer — a permanent chip would be clutter in the
    // header of most businesses on the platform.
    expect(
      branchSwitcherMode({ canSwitch: false, businessLocationCount: 1, accessibleCount: 1 }),
    ).toBe("hidden");
  });

  it("shows a static label to a member pinned to one branch of a larger business", () => {
    // Same canSwitch, same reachable count as the case above — only the
    // business-wide count separates them, which is why it is passed at all.
    expect(
      branchSwitcherMode({ canSwitch: false, businessLocationCount: 5, accessibleCount: 1 }),
    ).toBe("label");
  });

  it("labels at exactly two business branches, the first point a member can be in the 'wrong' one", () => {
    expect(
      branchSwitcherMode({ canSwitch: false, businessLocationCount: 2, accessibleCount: 1 }),
    ).toBe("label");
  });

  it("falls back to the reachable count when the business count is missing", () => {
    // An older response without the field must not resurrect the chip for a
    // single-branch business...
    expect(branchSwitcherMode({ canSwitch: false, accessibleCount: 1 })).toBe("hidden");
    // ...and a member who reaches several branches but somehow can't switch
    // still gets told where they are.
    expect(branchSwitcherMode({ canSwitch: false, accessibleCount: 2 })).toBe("label");
  });

  it("prefers the business count over the reachable count when they disagree", () => {
    // The reachable count is the narrowed one; trusting it is exactly the bug.
    expect(
      branchSwitcherMode({ canSwitch: false, businessLocationCount: 4, accessibleCount: 1 }),
    ).toBe("label");
  });

  it("never hides the control from someone who can switch, whatever the counts say", () => {
    // canSwitch is the member's own capability and outranks the counts; a
    // disagreement here means stale data, and a working menu is the safe side
    // of it.
    expect(
      branchSwitcherMode({ canSwitch: true, businessLocationCount: 1, accessibleCount: 1 }),
    ).toBe("menu");
    expect(branchSwitcherMode({ canSwitch: true, businessLocationCount: 0, accessibleCount: 0 }))
      .toBe("menu");
  });

  it("treats a zero-branch business as nothing to show", () => {
    expect(
      branchSwitcherMode({ canSwitch: false, businessLocationCount: 0, accessibleCount: 0 }),
    ).toBe("hidden");
  });
});
