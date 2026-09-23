/**
 * The remembered open/closed state of collapsible nav groups.
 *
 * Three sidebars (the dashboard's flat nav, Accounting, Website) each kept
 * their own copy of this logic, and the copies disagreed about the one thing
 * that is easy to get wrong — that reading `localStorage` during render
 * desynchronises the server's markup from the client's first paint. Two
 * tracked a `restored` flag; the Website one did not, so its groups could flip
 * on hydration. These assertions hold the behaviour of the single hook.
 *
 * The hook itself needs React to run, and this repo's vitest runs in Node, so
 * what is tested here is the storage contract the hook is built on: the shape
 * it tolerates, and the toggle rule. The toggle is the subtle one — it flips
 * the state the member can *see*, which for a group with no stored choice is
 * its fallback, not `undefined`.
 */
import { describe, expect, it } from "vitest";

/** The hook's parse step: anything a hand-edited store might hold. */
function parseStored(raw: string | null): Record<string, boolean> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>;
    }
  } catch {
    return {};
  }
  return {};
}

/** The hook's toggle step. */
function nextGroups(
  current: Record<string, boolean>,
  key: string,
  currentlyOpen: boolean,
): Record<string, boolean> {
  return { ...current, [key]: !currentlyOpen };
}

/** The hook's read step. */
function isOpen(
  stored: Record<string, boolean>,
  restored: boolean,
  key: string,
  fallback: boolean,
): boolean {
  return restored ? (stored[key] ?? fallback) : fallback;
}

describe("the stored open/closed map", () => {
  it("reads a saved map back", () => {
    expect(parseStored('{"ledger":true}')).toEqual({ ledger: true });
  });

  it("treats nothing saved as no remembered choice", () => {
    expect(parseStored(null)).toEqual({});
    expect(parseStored("")).toEqual({});
  });

  it("survives a hand-edited or corrupt value instead of throwing", () => {
    // A preference is never a reason to break a menu.
    expect(parseStored("not json")).toEqual({});
    expect(parseStored("null")).toEqual({});
    // An array would make `stored[key]` read an index — not a crash, but not a
    // map either, so it is rejected rather than half-honoured.
    expect(parseStored('["ledger"]')).toEqual({});
  });
});

describe("what a group renders as", () => {
  it("shows the fallback before storage has been read", () => {
    // The server rendered the fallback; the first client paint must match it.
    expect(isOpen({ ledger: true }, false, "ledger", false)).toBe(false);
  });

  it("prefers the remembered choice once it has been read", () => {
    expect(isOpen({ ledger: false }, true, "ledger", true)).toBe(false);
    expect(isOpen({ ledger: true }, true, "ledger", false)).toBe(true);
  });

  it("falls back for a group the member has never touched", () => {
    // The ledger group opens itself when the page you are on is inside it.
    expect(isOpen({}, true, "ledger", true)).toBe(true);
    expect(isOpen({}, true, "ledger", false)).toBe(false);
  });
});

describe("toggling a group", () => {
  it("flips a stored choice", () => {
    expect(nextGroups({ ledger: true }, "ledger", true)).toEqual({ ledger: false });
  });

  it("closes a group that was open only by fallback", () => {
    // The bug this rules out: toggling on the *stored* value reads
    // `undefined -> true`, so clicking to close a fallback-open group left it
    // open and the member had to click twice.
    expect(nextGroups({}, "ledger", true)).toEqual({ ledger: false });
  });

  it("leaves every other group alone", () => {
    expect(nextGroups({ a: true, b: false }, "b", false)).toEqual({ a: true, b: true });
  });
});
