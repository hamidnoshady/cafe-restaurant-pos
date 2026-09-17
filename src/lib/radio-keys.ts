/**
 * Keyboard rules for a button-based radiogroup («تومان/ریال», the branch
 * colour picker) — the framework-free half, so it is unit-testable the way
 * `branch-input.ts` is.
 *
 * `role="radio"` buttons promise arrow-key navigation (WAI-ARIA authoring
 * practices): ArrowDown moves to the next radio, ArrowUp to the previous, and
 * in a right-to-left group the horizontal arrows swap roles — ArrowLeft is
 * "next" because "next" is to the left. Home/End jump to the ends, and the
 * ring wraps around both ways. Without this, every option is its own Tab stop
 * and the arrows do nothing, which is a tab list wearing a radiogroup's
 * accessible name.
 */

/** The direction a keypress asks to move, or null when the key is not navigation. */
export type RadioMove = "next" | "previous" | "first" | "last";

/** Which move `key` asks for in a radiogroup laid out along the writing direction. */
export function radioMoveForKey(key: string, rtl: boolean): RadioMove | null {
  switch (key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "previous";
    case "Home":
      return "first";
    case "End":
      return "last";
    // In RTL the horizontal arrows point the other way round: the next option
    // sits to the LEFT, so ArrowLeft forwards and ArrowRight backs up. Passing
    // `rtl: false` keeps the LTR reading for any group that ever needs it.
    case "ArrowRight":
      return rtl ? "previous" : "next";
    case "ArrowLeft":
      return rtl ? "next" : "previous";
    default:
      return null;
  }
}

/**
 * The index a move lands on, wrapping past both ends, or null when there is
 * nothing to move between (one option) or the move is out of range.
 */
export function radioTargetIndex(move: RadioMove, current: number, count: number): number | null {
  if (count <= 0) return null;
  if (current < 0 || current >= count) return null;
  switch (move) {
    case "first":
      return 0;
    case "last":
      return count - 1;
    case "next":
      return count > 1 ? (current + 1) % count : null;
    case "previous":
      return count > 1 ? (current - 1 + count) % count : null;
  }
}
