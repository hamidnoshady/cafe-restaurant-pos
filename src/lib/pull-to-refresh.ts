/**
 * The pure half of the installed app's pull-to-refresh gesture
 * (`src/components/pull-to-refresh.tsx`) — the two decisions worth pinning
 * down, kept out of the component so they can be tested without a DOM.
 */

/** How far the finger travels before the pull commits to a refresh. */
export const PULL_THRESHOLD_PX = 72;
/** The pull is damped so the indicator trails the finger instead of racing it. */
export const PULL_DAMPING = 0.5;
/** Slack past the threshold, so an over-pull still feels elastic rather than stuck. */
const PULL_OVERSHOOT_PX = 16;

/** The bit of an element this cares about — so a test can pass plain objects. */
export interface ScrollableNode {
  scrollTop: number;
  parentElement: ScrollableNode | null;
}

/**
 * Whether a gesture starting on `target` is a pull on `root`, rather than a
 * scroll of something nested inside it.
 *
 * Any scroller between the two that is already scrolled down owns the gesture —
 * otherwise flicking a long product list back to its top would refresh the page
 * the moment it reached the top. A target outside `root` is not ours at all,
 * which is what stops a drawer or a modal from triggering a page refresh.
 */
export function pullStartsHere(target: ScrollableNode | null, root: ScrollableNode): boolean {
  for (let node = target; node; node = node.parentElement) {
    if (node.scrollTop > 0) return false;
    if (node === root) return true;
  }
  return false;
}

/**
 * How far to show the page pulled, given the finger's raw travel.
 *
 * `null` means the gesture is no longer a pull: any upward movement hands it
 * back, because the finger is scrolling and keeping the claim would swallow the
 * rest of the swipe.
 */
export function pullOffset(deltaY: number): number | null {
  if (deltaY <= 0) return null;
  return Math.min(deltaY * PULL_DAMPING, PULL_THRESHOLD_PX + PULL_OVERSHOOT_PX);
}
