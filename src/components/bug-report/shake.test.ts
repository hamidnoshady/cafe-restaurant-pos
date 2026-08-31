import { describe, expect, it } from "vitest";
import { createShakeDetector } from "./shake";

describe("createShakeDetector", () => {
  it("ignores acceleration below the threshold", () => {
    const detector = createShakeDetector();
    expect(detector.update(1000, 9.8)).toBe(false);
    expect(detector.update(1100, 15)).toBe(false);
  });

  it("requires several spikes within the window, not a single jolt", () => {
    const detector = createShakeDetector();
    expect(detector.update(1000, 20)).toBe(false);
    expect(detector.update(1300, 25)).toBe(false);
    // Third spike completes the shake.
    expect(detector.update(1600, 22)).toBe(true);
  });

  it("does not fire when spikes are spread beyond the window", () => {
    const detector = createShakeDetector({ windowMs: 500 });
    expect(detector.update(1000, 20)).toBe(false);
    expect(detector.update(2000, 25)).toBe(false);
    expect(detector.update(3000, 22)).toBe(false);
  });

  it("enforces a cooldown after firing", () => {
    const detector = createShakeDetector();
    expect(detector.update(1000, 20)).toBe(false);
    expect(detector.update(1100, 20)).toBe(false);
    expect(detector.update(1200, 20)).toBe(true);

    // Immediately shaking again should not fire within the cooldown.
    expect(detector.update(1250, 20)).toBe(false);
    expect(detector.update(1300, 20)).toBe(false);
    expect(detector.update(1350, 20)).toBe(false);
  });

  it("fires again once the cooldown has elapsed", () => {
    const detector = createShakeDetector({ cooldownMs: 1000 });
    expect(detector.update(1000, 20)).toBe(false);
    expect(detector.update(1010, 20)).toBe(false);
    expect(detector.update(1020, 20)).toBe(true);

    expect(detector.update(2100, 20)).toBe(false);
    expect(detector.update(2110, 20)).toBe(false);
    expect(detector.update(2120, 20)).toBe(true);
  });
});
