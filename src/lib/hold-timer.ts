/**
 * The timing brain behind the two hold gestures the till uses, kept pure so
 * it can be unit-tested with a fake clock instead of real timers.
 *
 *  * `confirm` — payment completion: nothing happens until the button has
 *    been held for the whole duration (۴ ثانیه), then the completion fires
 *    exactly once and the timer can never fire again.
 *  * `repeat` — add-on quantity: fires once per interval (۲ ثانیه) for as
 *    long as the hold lasts. The add-on gesture defers the first fire by a
 *    whole interval (`fireOnStart: false`), so a tap adds nothing at all.
 *
 * The component that owns one of these drives it with the timestamps it
 * already has (a requestAnimationFrame loop, or a test's fake clock):
 *
 *   press    → start()
 *   each tick → const t = timer.clock(); advance(t); progress(t)
 *   release  → cancel()
 *
 * **One clock, start to finish.** Every method defaults to the timer's own
 * `clock()`, which is the injected `now` in a test and a *monotonic* browser
 * clock (`performance.now()`) otherwise. The earlier version defaulted to
 * `Date.now()` while the animation loop fed it `performance.now()`, so the
 * two readings were epoch-milliseconds apart: `start()` stamped a ~1.7e12
 * value and the first `advance(performance.now())` (a few thousand at page
 * age) computed a hugely negative elapsed time — a hold that could never
 * complete on a fresh page, or completed instantly on an old one, depending
 * on which way the skew fell. Read the clock through `clock()` and hand the
 * same reading to `advance`/`progress` in a tick and that class of bug is
 * structurally impossible.
 *
 * `cancel` resets the hold (a released confirm-timer loses its progress; a
 * released repeat-timer stops adding), which is the behaviour both gestures
 * specify: letting go early must never complete the action. A confirm-timer
 * that *does* complete releases itself, so `isHeld` is false from the
 * completion onward and the finger still resting on the glass is holding
 * nothing.
 */

export type HoldTimerMode = "confirm" | "repeat";

export interface HoldTimerOptions {
  /** How long one full hold (confirm) or one interval between fires (repeat) is. */
  durationMs: number;
  /** Called each time the gesture produces an action — once for confirm, repeatedly for repeat. */
  onComplete: (occurrence: number) => void;
  mode: HoldTimerMode;
  /** Repeat mode: fire the first occurrence at start (a repeat key), or only after a full interval (an add-on's «نگه دار»). */
  fireOnStart?: boolean;
  /** The clock the timer reads. Injectable; defaults to {@link monotonicNow}. */
  now?: () => number;
}

/**
 * The one clock every hold gesture reads.
 *
 * `performance.now()` where it exists — monotonic, unaffected by a system
 * clock correction or an NTP step mid-hold, and the same origin the browser's
 * `requestAnimationFrame` timestamps use. `Date.now()` only as an SSR/very-old
 * runtime fallback, where nothing is animating anyway.
 */
export function monotonicNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export class HoldTimer {
  private readonly options: HoldTimerOptions;
  private startedAt: number | null = null;
  private lastFireAt: number | null = null;
  private fires = 0;
  /** Fires produced by the hold in progress — reset by every `start()`. */
  private firesThisHold = 0;
  /** Confirm mode only: once completed, no further start can ever complete again. */
  private completedOnce = false;

  constructor(options: HoldTimerOptions) {
    this.options = options;
  }

  /**
   * The timer's own clock. Callers read it once per tick and hand the same
   * value to `advance` and `progress`, so a frame can never mix two sources.
   */
  clock(): number {
    return this.options.now?.() ?? monotonicNow();
  }

  /** The hold begins. A repeat-timer fires its first occurrence right here when `fireOnStart` (the default). */
  start(now: number = this.clock()): void {
    if (this.completedOnce) return;
    if (this.startedAt !== null) return;
    this.startedAt = now;
    this.lastFireAt = null;
    this.firesThisHold = 0;
    if (this.options.mode === "repeat" && this.options.fireOnStart !== false) {
      this.fire(now);
    }
  }

  /** The hold ends early — progress resets, nothing completes. */
  cancel(): void {
    this.startedAt = null;
    this.lastFireAt = null;
  }

  private fire(now: number): void {
    this.fires += 1;
    this.firesThisHold += 1;
    this.lastFireAt = now;
    this.options.onComplete(this.fires);
  }

  /** Move time forward: completes the confirm hold, or fires the next repeat. */
  advance(now: number = this.clock()): void {
    if (this.startedAt === null) return;
    const { durationMs, mode } = this.options;
    if (mode === "confirm") {
      if (!this.completedOnce && now - this.startedAt >= durationMs) {
        this.completedOnce = true;
        // The hold is over the moment it completes, even though the finger is
        // still down: `isHeld` false is what stops the animation loop and
        // what tells a component reacting to its own disabling (payment is in
        // flight now) that there is no live hold left to tear down. Without
        // it the teardown ran and reset the fill to empty at the exact
        // instant the cashier needed to see it full.
        this.startedAt = null;
        this.fire(now);
      }
      return;
    }
    // A single late frame may have crossed several intervals (a backgrounded
    // tab, a long main-thread task). Fire once per interval actually elapsed,
    // anchored on the grid so the next increment stays a full interval away.
    let anchor = this.lastFireAt ?? this.startedAt;
    let guard = 0;
    while (now - anchor >= durationMs && guard < 1000) {
      // Re-read the anchor from the fire itself: a consumer that cancels the
      // hold from inside onComplete (a ceiling reached) must stop the loop.
      this.fire(anchor + durationMs);
      if (this.startedAt === null) return;
      anchor = this.lastFireAt ?? this.startedAt;
      guard += 1;
    }
  }

  /** 0..1 — how far toward the next fire this hold has come. */
  progress(now: number = this.clock()): number {
    if (this.startedAt === null) return 0;
    const anchor =
      this.options.mode === "repeat" ? (this.lastFireAt ?? this.startedAt) : this.startedAt;
    const elapsed = now - anchor;
    return Math.min(1, Math.max(0, elapsed / this.options.durationMs));
  }

  get isHeld(): boolean {
    return this.startedAt !== null;
  }

  get hasCompleted(): boolean {
    return this.completedOnce;
  }

  /** Total fires over the timer's whole life. */
  get occurrenceCount(): number {
    return this.fires;
  }

  /**
   * Fires produced by the *current* (or most recently ended) hold.
   *
   * This, not `occurrenceCount`, is what answers "was that press a tap?" — a
   * press adds nothing iff it produced no fire of its own. Asking the lifetime
   * total instead made every press after the first successful hold look like a
   * hold, which silently killed the add-on picker's double-tap decrement on any
   * option a cashier had already added to.
   */
  get holdOccurrenceCount(): number {
    return this.firesThisHold;
  }
}

/** Whether the user asked the system for reduced motion (SSR-safe). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
