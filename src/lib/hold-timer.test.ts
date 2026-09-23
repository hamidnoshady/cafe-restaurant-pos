import { describe, expect, it, vi } from "vitest";
import { HoldTimer, monotonicNow, prefersReducedMotion } from "./hold-timer";

describe("HoldTimer — confirm mode (payment completion)", () => {
  function confirmTimer(onComplete: () => void, durationMs = 4000) {
    let clock = 0;
    const timer = new HoldTimer({ durationMs, mode: "confirm", onComplete, now: () => clock });
    return {
      timer,
      advanceTo: (ms: number) => {
        clock = ms;
        timer.advance(ms);
      },
    };
  }

  it("does not complete before the full duration", () => {
    const onComplete = vi.fn();
    const { timer, advanceTo } = confirmTimer(onComplete);
    timer.start();
    advanceTo(3999);
    expect(onComplete).not.toHaveBeenCalled();
    expect(timer.progress(3999)).toBeCloseTo(3999 / 4000);
  });

  it("completes exactly once at the full duration", () => {
    const onComplete = vi.fn();
    const { timer, advanceTo } = confirmTimer(onComplete);
    timer.start();
    advanceTo(4000);
    expect(onComplete).toHaveBeenCalledTimes(1);
    advanceTo(9000);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(timer.hasCompleted).toBe(true);
  });

  it("cancel resets progress and does not complete", () => {
    const onComplete = vi.fn();
    const { timer, advanceTo } = confirmTimer(onComplete);
    timer.start();
    advanceTo(2500);
    timer.cancel();
    expect(timer.progress(2500)).toBe(0);
    advanceTo(9000);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("a released hold that restarts must run the whole duration again", () => {
    const onComplete = vi.fn();
    const { timer, advanceTo } = confirmTimer(onComplete);
    timer.start();
    advanceTo(3000);
    timer.cancel();
    timer.start();
    advanceTo(3000 + 3999);
    expect(onComplete).not.toHaveBeenCalled();
    advanceTo(3000 + 4000);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("never fires again after completing, even on a fresh start", () => {
    const onComplete = vi.fn();
    const { timer, advanceTo } = confirmTimer(onComplete);
    timer.start();
    advanceTo(4000);
    timer.cancel();
    timer.start();
    advanceTo(99_999);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("releases itself on completion, so the finger still down is holding nothing", () => {
    // The button reads `isHeld` to decide whether there is a live hold to tear
    // down. Staying "held" after completing made the teardown that runs when
    // the button disables itself reset the fill to empty at the exact instant
    // the cashier needed to see it full.
    const onComplete = vi.fn();
    const { timer, advanceTo } = confirmTimer(onComplete);
    timer.start();
    advanceTo(4000);
    expect(timer.isHeld).toBe(false);
    expect(timer.hasCompleted).toBe(true);
  });

  it("ignores a second start while already held", () => {
    const onComplete = vi.fn();
    const { timer, advanceTo } = confirmTimer(onComplete);
    timer.start();
    advanceTo(1000);
    timer.start();
    advanceTo(4000);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe("HoldTimer — repeat mode (add-on quantity)", () => {
  function repeatTimer(onComplete: () => void, intervalMs = 2000) {
    let clock = 0;
    const timer = new HoldTimer({ durationMs: intervalMs, mode: "repeat", onComplete, now: () => clock });
    return {
      timer,
      advanceTo: (ms: number) => {
        clock = ms;
        timer.advance(ms);
      },
    };
  }

  it("fires the first occurrence immediately on start", () => {
    const onComplete = vi.fn();
    const { timer } = repeatTimer(onComplete);
    timer.start();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(timer.occurrenceCount).toBe(1);
  });

  it("adds one more every interval while held", () => {
    const onComplete = vi.fn();
    const { timer, advanceTo } = repeatTimer(onComplete);
    timer.start(); // 0s → first add
    advanceTo(2000); // 2s → quantity 2
    advanceTo(4000); // 4s → quantity 3
    advanceTo(6000); // 6s → quantity 4
    expect(onComplete).toHaveBeenCalledTimes(4);
  });

  it("a late frame fires once, not twice, and re-anchors the grid", () => {
    const onComplete = vi.fn();
    const { timer, advanceTo } = repeatTimer(onComplete);
    timer.start(); // 0s → 1
    advanceTo(2500); // frame arrived late → 2 (not 2×)
    expect(onComplete).toHaveBeenCalledTimes(2);
    advanceTo(4400); // next fire was anchored at 4000 → 3
    expect(onComplete).toHaveBeenCalledTimes(3);
    advanceTo(4500); // not yet at 6000 → still 3
    expect(onComplete).toHaveBeenCalledTimes(3);
  });

  it("cancel stops the repeats", () => {
    const onComplete = vi.fn();
    const { timer, advanceTo } = repeatTimer(onComplete);
    timer.start();
    advanceTo(2000);
    timer.cancel();
    advanceTo(60_000);
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(timer.progress(60_000)).toBe(0);
  });

  it("a fresh press after release adds immediately again", () => {
    const onComplete = vi.fn();
    const { timer, advanceTo } = repeatTimer(onComplete);
    timer.start();
    advanceTo(1000);
    timer.cancel();
    timer.start();
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it("progress climbs toward the next increment and resets after each fire", () => {
    const onComplete = vi.fn();
    const { timer, advanceTo } = repeatTimer(onComplete);
    timer.start();
    advanceTo(1000);
    expect(timer.progress(1000)).toBeCloseTo(0.5);
    advanceTo(2000);
    expect(timer.progress(2000)).toBe(0);
  });

  it("can defer the first fire by a full interval (add-on: tap toggles, hold adds)", () => {
    const onComplete = vi.fn();
    let clock = 0;
    const timer = new HoldTimer({
      durationMs: 2000,
      mode: "repeat",
      fireOnStart: false,
      onComplete,
      now: () => clock,
    });
    timer.start();
    expect(onComplete).not.toHaveBeenCalled();
    clock = 1999;
    timer.advance(clock);
    expect(onComplete).not.toHaveBeenCalled();
    clock = 2000;
    timer.advance(clock);
    expect(onComplete).toHaveBeenCalledTimes(1);
    clock = 4000;
    timer.advance(clock);
    expect(onComplete).toHaveBeenCalledTimes(2);
  });
});

describe("HoldTimer — a tap is \"this press added nothing\", not \"nothing was ever added\"", () => {
  function repeatTimer(intervalMs = 2000) {
    let clock = 0;
    const onComplete = vi.fn();
    const timer = new HoldTimer({
      durationMs: intervalMs,
      mode: "repeat",
      fireOnStart: false,
      onComplete,
      now: () => clock,
    });
    return {
      timer,
      onComplete,
      advanceTo: (ms: number) => {
        clock = ms;
        timer.advance(ms);
      },
      set: (ms: number) => {
        clock = ms;
      },
    };
  }

  it("counts this hold's fires separately from the lifetime total", () => {
    const { timer, advanceTo, set } = repeatTimer();

    timer.start();
    advanceTo(2000);
    advanceTo(4000);
    expect(timer.holdOccurrenceCount).toBe(2);
    expect(timer.occurrenceCount).toBe(2);

    timer.cancel();
    set(4100);
    timer.start();
    // A tap: pressed and released without reaching an interval.
    set(4200);
    timer.advance(4200);
    expect(timer.holdOccurrenceCount).toBe(0);
    expect(timer.occurrenceCount).toBe(2);
  });

  it("is what keeps the decrement alive on an option that was already added to", () => {
    // The regression: reading the lifetime count made every press after the
    // first successful hold look like a hold, so the double tap that removes a
    // unit could never be recognised on that option again.
    const { timer, advanceTo, set } = repeatTimer();
    timer.start();
    advanceTo(2000);
    timer.cancel();

    for (const at of [3000, 3200, 3400]) {
      set(at);
      timer.start();
      set(at + 50);
      timer.advance(at + 50);
      expect(timer.holdOccurrenceCount).toBe(0);
      timer.cancel();
    }
  });
});

describe("clock()", () => {
  it("is the injected clock when one is given", () => {
    let clock = 42;
    const timer = new HoldTimer({
      durationMs: 1000,
      mode: "confirm",
      onComplete: vi.fn(),
      now: () => clock,
    });
    expect(timer.clock()).toBe(42);
    clock = 99;
    expect(timer.clock()).toBe(99);
  });

  it("defaults to the monotonic clock, and start/advance/progress share it", () => {
    const onComplete = vi.fn();
    const timer = new HoldTimer({ durationMs: 1000, mode: "confirm", onComplete });

    // No explicit timestamps anywhere: this is the path the browser takes, and
    // the one that broke when start() read Date.now() while the frame loop fed
    // it performance.now(). A reading of one clock against the other was
    // ~1.7e12 apart, so the hold either never completed or completed instantly.
    const before = timer.clock();
    timer.start();
    timer.advance();
    expect(onComplete).not.toHaveBeenCalled();
    expect(timer.progress()).toBeLessThan(0.5);
    expect(timer.clock()).toBeGreaterThanOrEqual(before);
  });

  it("monotonicNow never goes backwards across two reads", () => {
    expect(monotonicNow()).toBeLessThanOrEqual(monotonicNow());
  });
});

describe("prefersReducedMotion", () => {
  it("is false when there is no window (SSR) or no matchMedia", () => {
    // Node, which is exactly the SSR case: neither must throw.
    expect(prefersReducedMotion()).toBe(false);
  });
});
