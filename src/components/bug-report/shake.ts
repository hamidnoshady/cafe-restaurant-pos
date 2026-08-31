/**
 * The pure "is this a shake?" classifier behind `use-shake.ts`.
 *
 * Kept separate from the DOM so the counting rules are unit-testable without
 * a `devicemotion` event. A shake is N acceleration spikes within a short
 * window (so a single jolt in a pocket does not count), followed by a cooldown
 * so one long shake does not fire the handler repeatedly.
 */

export interface ShakeDetectorOptions {
  /** Acceleration magnitude (m/s², gravity included) that counts as a spike. */
  threshold?: number;
  /** How long spikes are remembered for, in ms. */
  windowMs?: number;
  /** Spikes required within the window to qualify as a shake. */
  spikes?: number;
  /** Minimum gap between two shakes, in ms. */
  cooldownMs?: number;
}

const DEFAULT_THRESHOLD = 18; // above the ~9.8 m/s² of gravity at rest
const DEFAULT_WINDOW_MS = 900;
const DEFAULT_SPIKES = 3;
const DEFAULT_COOLDOWN_MS = 3000;

export interface ShakeDetector {
  /** Feed one sample; returns true exactly when a shake is recognised. */
  update: (now: number, magnitude: number) => boolean;
  /** Forget the sample history (e.g. when the tab is hidden mid-gesture). */
  reset: () => void;
}

export function createShakeDetector(options: ShakeDetectorOptions = {}): ShakeDetector {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const spikesRequired = options.spikes ?? DEFAULT_SPIKES;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  let spikes: number[] = [];
  // -Infinity (not 0) so the very first shake a user makes fires immediately
  // rather than being swallowed by the cooldown window from epoch time.
  let lastFiredAt = Number.NEGATIVE_INFINITY;

  return {
    update(now, magnitude) {
      spikes = spikes.filter((t) => now - t < windowMs);
      if (magnitude >= threshold) spikes.push(now);

      const inWindow = spikes.filter((t) => now - t < windowMs).length;
      if (inWindow >= spikesRequired && now - lastFiredAt > cooldownMs) {
        lastFiredAt = now;
        spikes = [];
        return true;
      }
      return false;
    },
    reset() {
      spikes = [];
    },
  };
}
