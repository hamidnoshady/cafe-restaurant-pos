import { describe, expect, it } from "vitest";
import {
  INVITATION_TTL_DAYS,
  checkLastOwner,
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiry,
  invitationStatus,
  isPasswordRole,
  isPinRole,
  lockoutMessage,
  overridesAreEmpty,
  resolveMemberLocationAssignment,
  sanitizeOverrides,
  type MemberSummary,
} from "./team";
import { PERMISSIONS } from "./permissions";

describe("invitation tokens", () => {
  it("returns a prefixed token and its hash, never storing the plaintext", () => {
    const { token, tokenHash } = generateInvitationToken();
    expect(token.startsWith("inv_")).toBe(true);
    expect(tokenHash).toBe(hashInvitationToken(token));
    // The hash must not contain the token — it's what gets persisted.
    expect(tokenHash).not.toContain(token.slice(4));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates a distinct token every time", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateInvitationToken().token));
    expect(tokens.size).toBe(50);
  });

  it("hashes deterministically so a presented token can be looked up", () => {
    expect(hashInvitationToken("inv_abc")).toBe(hashInvitationToken("inv_abc"));
    expect(hashInvitationToken("inv_abc")).not.toBe(hashInvitationToken("inv_abd"));
  });

  it("expires the configured number of days out", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const expiry = invitationExpiry(now);
    expect(expiry.getTime() - now.getTime()).toBe(INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
  });
});

describe("invitationStatus", () => {
  const future = new Date("2026-02-01T00:00:00Z");
  const now = new Date("2026-01-10T00:00:00Z");

  it("is pending while unused and unexpired", () => {
    expect(invitationStatus({ expiresAt: future, acceptedAt: null, revokedAt: null }, now)).toBe(
      "pending",
    );
  });

  it("reports accepted ahead of every other state", () => {
    // An accepted invitation that later expires is still "accepted" — the
    // membership exists, and reporting "expired" would be misleading.
    expect(
      invitationStatus(
        { expiresAt: new Date("2026-01-01T00:00:00Z"), acceptedAt: now, revokedAt: now },
        now,
      ),
    ).toBe("accepted");
  });

  it("reports revoked before expiry", () => {
    expect(invitationStatus({ expiresAt: future, acceptedAt: null, revokedAt: now }, now)).toBe(
      "revoked",
    );
  });

  it("expires exactly at the boundary, not after it", () => {
    const at = new Date("2026-01-10T00:00:00Z");
    expect(invitationStatus({ expiresAt: at, acceptedAt: null, revokedAt: null }, at)).toBe("expired");
  });

  it("accepts ISO strings as they come back from the database", () => {
    expect(
      invitationStatus(
        { expiresAt: "2026-02-01T00:00:00Z", acceptedAt: null, revokedAt: null },
        now,
      ),
    ).toBe("pending");
  });
});

describe("role families", () => {
  it("separates password roles from PIN roles exhaustively", () => {
    for (const role of ["owner", "admin", "manager", "accountant"] as const) {
      expect(isPasswordRole(role)).toBe(true);
      expect(isPinRole(role)).toBe(false);
    }
    for (const role of ["cashier", "waiter", "kitchen"] as const) {
      expect(isPinRole(role)).toBe(true);
      expect(isPasswordRole(role)).toBe(false);
    }
  });
});

describe("checkLastOwner", () => {
  const members: MemberSummary[] = [
    { id: "owner-1", role: "owner", isActive: true },
    { id: "manager-1", role: "manager", isActive: true },
    { id: "owner-2", role: "owner", isActive: false },
  ];

  it("blocks demoting the only active owner", () => {
    expect(checkLastOwner(members, "owner-1", { role: "manager" })).toBe("last_owner");
  });

  it("blocks suspending the only active owner", () => {
    expect(checkLastOwner(members, "owner-1", { isActive: false })).toBe("last_owner");
  });

  it("blocks removing the only active owner", () => {
    expect(checkLastOwner(members, "owner-1", { remove: true })).toBe("last_owner");
  });

  it("does not count a suspended owner as a way back in", () => {
    // owner-2 exists but is inactive, so owner-1 is still the last active one.
    expect(checkLastOwner(members, "owner-1", { remove: true })).toBe("last_owner");
  });

  it("allows the change once a second active owner exists", () => {
    const withTwo: MemberSummary[] = [...members, { id: "owner-3", role: "owner", isActive: true }];
    expect(checkLastOwner(withTwo, "owner-1", { role: "manager" })).toBeNull();
    expect(checkLastOwner(withTwo, "owner-1", { remove: true })).toBeNull();
    expect(checkLastOwner(withTwo, "owner-1", { isActive: false })).toBeNull();
  });

  it("ignores changes that keep the owner an active owner", () => {
    expect(checkLastOwner(members, "owner-1", { role: "owner" })).toBeNull();
    expect(checkLastOwner(members, "owner-1", { isActive: true })).toBeNull();
    expect(checkLastOwner(members, "owner-1", {})).toBeNull();
  });

  it("never blocks changes to non-owners", () => {
    expect(checkLastOwner(members, "manager-1", { remove: true })).toBeNull();
    expect(checkLastOwner(members, "owner-2", { remove: true })).toBeNull();
  });

  it("is a no-op for an unknown member", () => {
    expect(checkLastOwner(members, "nobody", { remove: true })).toBeNull();
  });

  it("has a message for every reason it can return", () => {
    expect(lockoutMessage("last_owner")).toContain("مالک");
  });
});

describe("sanitizeOverrides", () => {
  it("keeps known permissions and sorts them", () => {
    expect(
      sanitizeOverrides({ granted: [PERMISSIONS.ledgerPost, PERMISSIONS.accountsEdit] }),
    ).toEqual({
      granted: [PERMISSIONS.accountsEdit, PERMISSIONS.ledgerPost].sort(),
      revoked: [],
    });
  });

  it("drops unknown and non-string keys instead of rejecting the payload", () => {
    // A stale browser tab naming a removed permission must not 400.
    expect(sanitizeOverrides({ granted: ["made.up", 7, null, PERMISSIONS.menuEdit] })).toEqual({
      granted: [PERMISSIONS.menuEdit],
      revoked: [],
    });
  });

  it("never delegates owner-only permissions", () => {
    expect(sanitizeOverrides({ granted: [PERMISSIONS.apiManage], revoked: [PERMISSIONS.apiManage] })).toEqual({
      granted: [],
      revoked: [],
    });
  });

  it("de-duplicates", () => {
    expect(sanitizeOverrides({ revoked: [PERMISSIONS.menuEdit, PERMISSIONS.menuEdit] })).toEqual({
      granted: [],
      revoked: [PERMISSIONS.menuEdit],
    });
  });

  it("returns empty overrides for junk", () => {
    for (const input of [null, undefined, "x", 5, [], { granted: "not-an-array" }]) {
      expect(sanitizeOverrides(input)).toEqual({ granted: [], revoked: [] });
    }
  });

  it("detects the empty case so it can be stored as {}", () => {
    expect(overridesAreEmpty(sanitizeOverrides(null))).toBe(true);
    expect(overridesAreEmpty(sanitizeOverrides({ granted: [PERMISSIONS.menuEdit] }))).toBe(false);
  });
});

describe("resolveMemberLocationAssignment", () => {
  // Three branches of one business, in creation order.
  const known = ["loc-1", "loc-2", "loc-3"];
  const foreign = "loc-of-another-business";

  it("keeps a plain assignment, order preserved and duplicates folded", () => {
    expect(resolveMemberLocationAssignment(known, ["loc-3", "loc-1", "loc-3"], undefined)).toEqual({
      locationIds: ["loc-3", "loc-1"],
      defaultLocationId: null,
    });
  });

  it("folds the default into the assignment it must belong to", () => {
    expect(resolveMemberLocationAssignment(known, ["loc-1"], "loc-2")).toEqual({
      locationIds: ["loc-1", "loc-2"],
      defaultLocationId: "loc-2",
    });
  });

  it("keeps the default when it is already in the list, without duplicating it", () => {
    expect(resolveMemberLocationAssignment(known, ["loc-1", "loc-2"], "loc-2")).toEqual({
      locationIds: ["loc-1", "loc-2"],
      defaultLocationId: "loc-2",
    });
  });

  it("accepts a default alone — assigning only a home branch", () => {
    expect(resolveMemberLocationAssignment(known, undefined, "loc-1")).toEqual({
      locationIds: ["loc-1"],
      defaultLocationId: "loc-1",
    });
  });

  it("answers empty for a write that names nothing", () => {
    expect(resolveMemberLocationAssignment(known, [], null)).toEqual({
      locationIds: [],
      defaultLocationId: null,
    });
    expect(resolveMemberLocationAssignment(known, undefined, undefined)).toEqual({
      locationIds: [],
      defaultLocationId: null,
    });
    // Blank strings are "not chosen", the same as absent — an untouched form
    // field must not become an unknown-location refusal.
    expect(resolveMemberLocationAssignment(known, [""], "")).toEqual({
      locationIds: [],
      defaultLocationId: null,
    });
  });

  it("refuses a branch the business does not own, wherever it appears", () => {
    // In the assignment — the cross-tenant reference this rule exists to stop.
    expect(resolveMemberLocationAssignment(known, ["loc-1", foreign], null)).toBeNull();
    // In both lists at once.
    expect(resolveMemberLocationAssignment(known, [foreign], foreign)).toBeNull();
    // As the default alone: a home branch nobody owns is still foreign.
    expect(resolveMemberLocationAssignment(known, [], foreign)).toBeNull();
  });

  it("refuses nothing when the write is empty even though the business has branches", () => {
    // The guard must not turn "clear the assignment" into "unknown location":
    // an owner unticking every branch is a legal write.
    expect(resolveMemberLocationAssignment(known, [], undefined)).toEqual({
      locationIds: [],
      defaultLocationId: null,
    });
  });
});
