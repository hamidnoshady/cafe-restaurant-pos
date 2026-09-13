import { describe, expect, it } from "vitest";
import { BRANCH_EDIT_FIELDS, branchPatchIntent } from "./branch-patch-intent";

describe("branchPatchIntent", () => {
  it("reads a rename as an edit", () => {
    expect(branchPatchIntent({ name: "ونک ۲" })).toEqual({ kind: "edit" });
  });

  it("reads each editable field as an edit on its own", () => {
    for (const field of BRANCH_EDIT_FIELDS) {
      expect(branchPatchIntent({ [field]: "x" })).toEqual({ kind: "edit" });
    }
  });

  it("treats an explicit null as a real edit, not an absent field", () => {
    // Clearing an address is `address: null`, which is a change; only
    // `undefined` means "not mentioned".
    expect(branchPatchIntent({ address: null })).toEqual({ kind: "edit" });
    expect(branchPatchIntent({ phone: null })).toEqual({ kind: "edit" });
  });

  it("separates activation from deactivation", () => {
    expect(branchPatchIntent({ isActive: true })).toEqual({ kind: "activate" });
    expect(branchPatchIntent({ isActive: false })).toEqual({ kind: "deactivate" });
  });

  it("refuses a body that edits and toggles at once", () => {
    // The whole reason this function exists: the two halves are not
    // transactional together, so a rename could commit while the
    // deactivation failed, and the caller would see only the failure.
    expect(branchPatchIntent({ name: "New", isActive: false })).toEqual({ kind: "bad_request" });
    expect(branchPatchIntent({ color: "teal", isActive: true })).toEqual({ kind: "bad_request" });
  });

  it("refuses a non-boolean isActive rather than coercing it", () => {
    // "false" and 0 are the shapes a hand-rolled client sends, and both would
    // deactivate a branch if this were truthiness-tested.
    for (const value of ["false", "true", 0, 1, null]) {
      expect(branchPatchIntent({ isActive: value })).toEqual({ kind: "bad_request" });
    }
  });

  it("reports an empty body as nothing to change rather than a silent success", () => {
    // This used to answer `{ ok: true }` having done nothing at all.
    expect(branchPatchIntent({})).toEqual({ kind: "nothing_to_change" });
  });

  it("ignores unknown keys, which on their own change nothing", () => {
    expect(branchPatchIntent({ nonsense: 1 } as Record<string, unknown>)).toEqual({
      kind: "nothing_to_change",
    });
  });

  it("still refuses the combination when the edit rides in on an unknown-to-old-code field", () => {
    // colour was the most recent field added to this endpoint; if it were
    // left out of BRANCH_EDIT_FIELDS, `{ color, isActive }` would sail past
    // the guard as a pure toggle and drop the colour change on the floor.
    expect(BRANCH_EDIT_FIELDS).toContain("color");
    expect(branchPatchIntent({ color: "rose", isActive: false })).toEqual({ kind: "bad_request" });
  });
});
