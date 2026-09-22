/**
 * The timing brain behind the two hold gestures the till uses, kept pure so
 * it can be unit-tested with a fake clock instead of real timers.
 *
 *  * `confirm` — payment completion: nothing happens until the button has
 *    been held for the whole duration (۴ ثانیه), then the completion fires
 *    exactly once and the timer can never fire again.
 *  * `repeat` — add-on quantity: fires immediately on start (the first add),
 *    then once more every interval (۲ ثانیه) for as long as the hold lasts.
 *
 * The component that owns one of these drives it with the timestamps it
 * already has (a requestAnimationFrame loop, or a test's fake clock):
 *
 *   press    → start(now)
 *   each tick → advance(now), read progress(now)
 *   release  → cancel()
 *
 * `cancel` resets the hold (a released confirm-timer loses its progress; a
 * released repeat-timer stops adding), which is the behaviour both gestures
 * specify: letting go early must never complete the action.
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
  /** The clock the timer reads. Injectable; defaults to Date.now. */
  now?: () => number;
}

export class HoldTimer {
  private readonly options: HoldTimerOptions;
  private startedAt: number | null = null;
  private lastFireAt: number | null = null;
  private fires = 0;
  /** Confirm mode only: once completed, no further start can ever complete again. */
  private completedOnce = false;

  constructor(options: HoldTimerOptions) {
    this.options = options;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** The hold begins. A repeat-timer fires its first occurrence right here when `fireOnStart` (the default). */
  start(): void {
    if (this.completedOnce) return;
    if (this.startedAt !== null) return;
    const now = this.now();
    this.startedAt = now;
    this.lastFireAt = null;
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
    this.lastFireAt = now;
    this.options.onComplete(this.fires);
  }

  /** Move time forward: completes the confirm hold, or fires the next repeat. */
  advance(now: number): void {
    if (this.startedAt === null) return;
    const { durationMs, mode } = this.options;
    if (mode === "confirm") {
      if (!this.completedOnce && now - this.startedAt >= durationMs) {
        this.completedOnce = true;
        this.fire(now);
      }
      return;
    }
    const anchor = this.lastFireAt ?? this.startedAt;
    if (now - anchor >= durationMs) {
      // Anchor on the grid, not on the tick: a late frame fires once, not
      // twice, and the next increment stays a full interval away.
      this.fire(anchor + durationMs);
    }
  }

  /** 0..1 — how far toward the next fire this hold has come. */
  progress(now: number = this.now()): number {
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

  get occurrenceCount(): number {
    return this.fires;
  }
}

/** Whether the user asked the system for reduced motion (SSR-safe). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
