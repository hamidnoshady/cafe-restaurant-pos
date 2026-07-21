import { describe, expect, it } from "vitest";
import { findConflicts, isNoShowOverdue, windowEndMs, windowsOverlap } from "./reservations";

const AT = (h: number, m = 0) => Date.UTC(2026, 6, 21, h - 3, m - 30); // Tehran +03:30 → arbitrary but consistent

describe("windowEndMs", () => {
  it("adds the turn time in minutes", () => {
    expect(windowEndMs({ startMs: 1_000_000, durationMinutes: 90 })).toBe(1_000_000 + 90 * 60_000);
  });
});

describe("windowsOverlap", () => {
  it("detects overlapping windows", () => {
    const a = { startMs: AT(19, 0), durationMinutes: 90 }; // 19:00–20:30
    const b = { startMs: AT(20, 0), durationMinutes: 90 }; // 20:00–21:30
    expect(windowsOverlap(a, b)).toBe(true);
  });

  it("treats back-to-back windows as non-overlapping (half-open)", () => {
    const a = { startMs: AT(19, 0), durationMinutes: 90 }; // ends 20:30
    const b = { startMs: AT(20, 30), durationMinutes: 90 }; // starts 20:30
    expect(windowsOverlap(a, b)).toBe(false);
  });

  it("returns false for clearly separate windows", () => {
    const a = { startMs: AT(12, 0), durationMinutes: 60 };
    const b = { startMs: AT(20, 0), durationMinutes: 60 };
    expect(windowsOverlap(a, b)).toBe(false);
  });
});

describe("findConflicts", () => {
  const existing = [
    { id: "r1", startMs: AT(19, 0), durationMinutes: 90 },
    { id: "r2", startMs: AT(21, 0), durationMinutes: 90 },
  ];

  it("returns the overlapping existing reservations", () => {
    const candidate = { startMs: AT(19, 30), durationMinutes: 30 }; // 19:30–20:00, inside r1 only
    expect(findConflicts(candidate, existing).map((r) => r.id)).toEqual(["r1"]);
  });

  it("flags a long window that spans two bookings", () => {
    const candidate = { startMs: AT(20, 0), durationMinutes: 90 }; // 20:00–21:30
    expect(findConflicts(candidate, existing).map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("finds no conflict in a free gap", () => {
    const candidate = { startMs: AT(20, 30), durationMinutes: 30 }; // 20:30–21:00
    expect(findConflicts(candidate, existing)).toEqual([]);
  });

  it("does not conflict a reservation with itself when editing", () => {
    const candidate = { id: "r1", startMs: AT(19, 0), durationMinutes: 90 };
    expect(findConflicts(candidate, existing)).toEqual([]);
  });
});

describe("isNoShowOverdue", () => {
  it("is false before the grace period elapses", () => {
    const start = AT(19, 0);
    expect(isNoShowOverdue(start, start + 10 * 60_000, 15)).toBe(false);
  });

  it("is true once the grace period passes with nobody seated", () => {
    const start = AT(19, 0);
    expect(isNoShowOverdue(start, start + 20 * 60_000, 15)).toBe(true);
  });
});
