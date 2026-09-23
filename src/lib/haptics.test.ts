import { afterEach, describe, expect, it, vi } from "vitest";
import { HAPTIC, supportsVibration, vibrate } from "./haptics";

/**
 * These run in Node, where there is no `navigator` at all — which is the
 * genuinely important case, not a limitation of the setup: the same modules
 * render on the server, and every desktop browser and every iOS Safari is the
 * same "no Vibration API" shape. A buzz is a bonus on top of the visual fill,
 * so the only contract is that asking for one is always safe.
 *
 * Whether a real phone actually vibrates cannot be asserted from a test
 * runner; that is a device check, and these tests do not claim it.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("supportsVibration", () => {
  it("is false where there is no navigator (SSR, and this runner)", () => {
    expect(supportsVibration()).toBe(false);
  });

  it("is false for a navigator without the API — desktop, iOS Safari", () => {
    vi.stubGlobal("navigator", {});
    expect(supportsVibration()).toBe(false);
  });

  it("is false when `vibrate` is present but is not callable", () => {
    vi.stubGlobal("navigator", { vibrate: true });
    expect(supportsVibration()).toBe(false);
  });

  it("is true for a navigator that exposes it", () => {
    vi.stubGlobal("navigator", { vibrate: () => true });
    expect(supportsVibration()).toBe(true);
  });
});

describe("vibrate", () => {
  it("does nothing, and reports so, where the API is absent", () => {
    expect(vibrate(20)).toBe(false);
  });

  it("passes the pattern through and reports acceptance", () => {
    const spy = vi.fn(() => true);
    vi.stubGlobal("navigator", { vibrate: spy });

    expect(vibrate(HAPTIC.increment)).toBe(true);
    expect(spy).toHaveBeenCalledWith(HAPTIC.increment);

    expect(vibrate(HAPTIC.success)).toBe(true);
    expect(spy).toHaveBeenLastCalledWith(HAPTIC.success);
  });

  it("reports a refused request rather than pretending it buzzed", () => {
    // What a browser returns when the user, a focus mode or a battery saver
    // has vibration switched off.
    vi.stubGlobal("navigator", { vibrate: () => false });
    expect(vibrate(20)).toBe(false);
  });

  it("swallows a throwing implementation, as some embedded WebViews are", () => {
    vi.stubGlobal("navigator", {
      vibrate: () => {
        throw new Error("NotAllowedError");
      },
    });
    expect(() => vibrate(20)).not.toThrow();
    expect(vibrate(20)).toBe(false);
  });
});

describe("HAPTIC", () => {
  it("keeps every buzz short enough to read as feedback rather than an alarm", () => {
    const durations = Object.values(HAPTIC).flatMap((value) =>
      Array.isArray(value) ? value : [value],
    );
    for (const duration of durations) {
      expect(duration).toBeGreaterThan(0);
      expect(duration).toBeLessThanOrEqual(50);
    }
  });

  it("gives the two gestures one shared vocabulary rather than per-button numbers", () => {
    expect(Object.keys(HAPTIC).sort()).toEqual(["increment", "milestone", "start", "success"]);
  });
});
