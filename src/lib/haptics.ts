/**
 * Haptic feedback for the two hold gestures, feature-detected.
 *
 * The Vibration API is the only haptic a web app gets, and it is absent on
 * desktop, absent on iOS Safari, and present-but-disabled whenever the user
 * (or the OS's focus mode, or a low-battery mode) says so. All three cases
 * must be indistinguishable from "no vibration" to the caller: the visual
 * progress fill is the primary feedback and the buzz is a bonus, so nothing
 * here throws, and every call is safe to make on every device.
 *
 * `navigator.vibrate` can also throw (some embedded WebViews reject it inside
 * a non-user gesture) and returns `false` when the request is refused —
 * `vibrate()` swallows both and reports what happened as a boolean, which is
 * what the tests assert against.
 */

/** Whether this runtime exposes the Vibration API at all. */
export function supportsVibration(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof (navigator as Navigator & { vibrate?: unknown }).vibrate === "function"
  );
}

/**
 * Buzz, if the device can. Returns whether the platform accepted the request
 * — never throws, so a caller can fire it from inside an animation frame or a
 * pointer handler without a guard of its own.
 */
export function vibrate(pattern: number | number[]): boolean {
  if (!supportsVibration()) return false;
  try {
    return navigator.vibrate(pattern) !== false;
  } catch {
    return false;
  }
}

/** The gesture-level vocabulary, so two buttons don't invent two buzz lengths. */
export const HAPTIC = {
  /** A hold has begun. */
  start: 12,
  /** A quarter of the way through a long hold. */
  milestone: 8,
  /** The hold completed — payment submitted. */
  success: [18, 40, 28] as number[],
  /** One add-on unit was added. */
  increment: 10,
} as const;
