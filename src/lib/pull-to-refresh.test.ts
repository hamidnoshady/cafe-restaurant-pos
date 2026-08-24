import { describe, expect, it } from "vitest";
import {
  PULL_THRESHOLD_PX,
  pullOffset,
  pullStartsHere,
  type ScrollableNode,
} from "./pull-to-refresh";

/** Builds a target→ancestor chain from the given scrollTops, innermost first. */
function chain(...scrollTops: number[]): ScrollableNode {
  let parent: ScrollableNode | null = null;
  for (const scrollTop of [...scrollTops].reverse()) {
    parent = { scrollTop, parentElement: parent };
  }
  return parent!;
}

/** The outermost node of a chain — what the component passes as `root`. */
function outermost(node: ScrollableNode): ScrollableNode {
  let current = node;
  while (current.parentElement) current = current.parentElement;
  return current;
}

describe("pullStartsHere", () => {
  it("claims the gesture when everything from target to root is at the top", () => {
    const target = chain(0, 0, 0);
    expect(pullStartsHere(target, outermost(target))).toBe(true);
  });

  it("claims it when the target is the root itself", () => {
    const root = chain(0);
    expect(pullStartsHere(root, root)).toBe(true);
  });

  it("declines when the root is already scrolled down", () => {
    const target = chain(0, 0, 120);
    expect(pullStartsHere(target, outermost(target))).toBe(false);
  });

  it("declines when a nested scroller owns the gesture", () => {
    // A long product list scrolled down inside a page that is at its top: the
    // list keeps the swipe, or flicking it back to the top would refresh.
    const target = chain(200, 0);
    expect(pullStartsHere(target, outermost(target))).toBe(false);
  });

  it("declines when the target sits outside the root", () => {
    const root: ScrollableNode = { scrollTop: 0, parentElement: null };
    const detached = chain(0, 0);
    expect(pullStartsHere(detached, root)).toBe(false);
  });

  it("declines when there is no target at all", () => {
    expect(pullStartsHere(null, { scrollTop: 0, parentElement: null })).toBe(false);
  });
});

describe("pullOffset", () => {
  it("hands the gesture back on any upward or flat movement", () => {
    expect(pullOffset(0)).toBeNull();
    expect(pullOffset(-40)).toBeNull();
  });

  it("damps the pull so the indicator trails the finger", () => {
    expect(pullOffset(40)).toBe(20);
  });

  it("needs more travel than the threshold to commit, and clamps the over-pull", () => {
    // Damping is what makes this the real contract: a finger that has moved
    // exactly the threshold has not committed yet.
    expect(pullOffset(PULL_THRESHOLD_PX)).toBeLessThan(PULL_THRESHOLD_PX);
    expect(pullOffset(PULL_THRESHOLD_PX * 2)).toBe(PULL_THRESHOLD_PX);
    expect(pullOffset(10_000)).toBe(PULL_THRESHOLD_PX + 16);
  });
});
