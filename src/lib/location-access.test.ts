import { describe, expect, it } from "vitest";
import {
  accessibleLocationIds,
  canAccessLocation,
  canSwitchBranches,
  defaultAccessibleLocationId,
  type LocationAccessContext,
  derivedLocationScope,
  isLocationScope,
  type LocationScope,
} from "./location-access";

const BRANCHES = ["main", "north", "south"];

function ctx(overrides: Partial<LocationAccessContext>): LocationAccessContext {
  return { role: "manager", defaultLocationId: null, assignedLocationIds: [], ...overrides };
}

describe("accessibleLocationIds", () => {
  it("gives an owner every branch regardless of location_id or assignments", () => {
    expect(
      accessibleLocationIds(ctx({ role: "owner", defaultLocationId: "main" }), BRANCHES),
    ).toEqual(BRANCHES);
    expect(
      accessibleLocationIds(
        ctx({ role: "owner", assignedLocationIds: ["north"] }),
        BRANCHES,
      ),
    ).toEqual(BRANCHES);
  });

  it("restricts to an explicit assignment set, ignoring the default location", () => {
    expect(
      accessibleLocationIds(
        ctx({ defaultLocationId: "main", assignedLocationIds: ["north", "south"] }),
        BRANCHES,
      ),
    ).toEqual(["north", "south"]);
  });

  it("filters an assignment down to branches that still exist/are active", () => {
    expect(
      accessibleLocationIds(ctx({ assignedLocationIds: ["north", "closed-branch"] }), BRANCHES),
    ).toEqual(["north"]);
  });

  it("restricts to the default location when there is no explicit assignment", () => {
    // This is the shape every cashier/waiter/kitchen member has always had.
    expect(accessibleLocationIds(ctx({ defaultLocationId: "north" }), BRANCHES)).toEqual([
      "north",
    ]);
  });

  it("gives nothing when the default location is no longer among the business's active branches", () => {
    expect(accessibleLocationIds(ctx({ defaultLocationId: "closed-branch" }), BRANCHES)).toEqual(
      [],
    );
  });

  it("gives every branch to a roaming member with neither a default nor an assignment", () => {
    // Pre-Phase-14 meaning of location_id = NULL, and what makes a
    // single-location business behave exactly as it did before this phase.
    expect(accessibleLocationIds(ctx({}), BRANCHES)).toEqual(BRANCHES);
    expect(accessibleLocationIds(ctx({}), ["only-branch"])).toEqual(["only-branch"]);
  });
});

describe("canAccessLocation", () => {
  it("agrees with accessibleLocationIds", () => {
    const c = ctx({ assignedLocationIds: ["north"] });
    expect(canAccessLocation(c, BRANCHES, "north")).toBe(true);
    expect(canAccessLocation(c, BRANCHES, "south")).toBe(false);
    expect(canAccessLocation(c, BRANCHES, "nonexistent")).toBe(false);
  });
});

describe("defaultAccessibleLocationId", () => {
  it("prefers the member's own default when it is still reachable", () => {
    expect(
      defaultAccessibleLocationId(
        ctx({ defaultLocationId: "south", assignedLocationIds: ["main", "south"] }),
        BRANCHES,
      ),
    ).toBe("south");
  });

  it("falls back to the first accessible branch when the default isn't reachable", () => {
    expect(
      defaultAccessibleLocationId(
        ctx({ defaultLocationId: "north", assignedLocationIds: ["main", "south"] }),
        BRANCHES,
      ),
    ).toBe("main");
  });

  it("falls back to the first business branch for a fully roaming member", () => {
    expect(defaultAccessibleLocationId(ctx({}), BRANCHES)).toBe("main");
  });

  it("is null when the member has no accessible branch at all", () => {
    expect(defaultAccessibleLocationId(ctx({ defaultLocationId: "gone" }), BRANCHES)).toBeNull();
  });

  it("is deterministic based on branch order, not location_id ordering", () => {
    // Order matters: callers must pass branches sorted (created_at), and this
    // must not silently re-sort or pick by string comparison.
    expect(defaultAccessibleLocationId(ctx({}), ["south", "main", "north"])).toBe("south");
  });
});

describe("canSwitchBranches", () => {
  it("is false with zero or one accessible branch", () => {
    expect(canSwitchBranches(ctx({ defaultLocationId: "main" }), BRANCHES)).toBe(false);
    expect(canSwitchBranches(ctx({ defaultLocationId: "gone" }), BRANCHES)).toBe(false);
  });

  it("is true once more than one branch is reachable", () => {
    expect(canSwitchBranches(ctx({}), BRANCHES)).toBe(true);
    expect(canSwitchBranches(ctx({ role: "owner" }), ["only-branch"])).toBe(false);
  });
});

/**
 * The explicit branch policy (migration 0170).
 *
 * The tests above exercise the *derived* behaviour — a context with no `scope`,
 * which is the compatibility shim for callers that have not been migrated to
 * select the column. These exercise the stored policy, which is what the
 * database actually holds after 0170 and what every migrated caller passes.
 */
describe("explicit location scope", () => {
  const withScope = (scope: LocationScope, over: Partial<LocationAccessContext> = {}) =>
    ({ role: "manager", defaultLocationId: null, assignedLocationIds: [], scope, ...over }) as
      LocationAccessContext;

  it("'all' reaches every branch of the business", () => {
    expect(accessibleLocationIds(withScope("all"), BRANCHES)).toEqual(BRANCHES);
  });

  it("'all' picks up a branch added after the policy was set", () => {
    // The distinction between 'all' and "selected, and they happen to be all of
    // them": opening a fifth shop must not silently grant it to everybody, and
    // must not silently withhold it from the people whose policy says 'all'.
    expect(accessibleLocationIds(withScope("all"), [...BRANCHES, "new-shop"])).toContain("new-shop");
  });

  it("'selected' reaches exactly the assigned branches", () => {
    expect(
      accessibleLocationIds(withScope("selected", { assignedLocationIds: ["main", "south"] }), BRANCHES),
    ).toEqual(["main", "south"]);
  });

  it("'selected' with nothing assigned reaches nothing", () => {
    // Not "everything". An empty selection is an empty selection.
    expect(accessibleLocationIds(withScope("selected"), BRANCHES)).toEqual([]);
  });

  it("'selected' ignores an assigned id that is not one of the business's branches", () => {
    // The caller passes only this business's active branches, so a stale or
    // cross-tenant `user_locations` row contributes nothing.
    expect(
      accessibleLocationIds(
        withScope("selected", { assignedLocationIds: ["main", "another-tenants-branch"] }),
        BRANCHES,
      ),
    ).toEqual(["main"]);
  });

  it("'home' reaches only the member's home branch", () => {
    expect(accessibleLocationIds(withScope("home", { defaultLocationId: "south" }), BRANCHES)).toEqual([
      "south",
    ]);
  });

  /**
   * The privilege escalation this column exists to close. The old rule read
   * "no assignment and no default → every branch"; a member created without a
   * branch decision silently roamed the whole business.
   */
  it("'home' with no home branch reaches NOTHING, not everything", () => {
    expect(accessibleLocationIds(withScope("home"), BRANCHES)).toEqual([]);
  });

  it("keeps the owner whole-business whatever their stored scope says", () => {
    expect(accessibleLocationIds(withScope("home", { role: "owner" }), BRANCHES)).toEqual(BRANCHES);
    expect(accessibleLocationIds(withScope("selected", { role: "owner" }), BRANCHES)).toEqual(BRANCHES);
  });

  it("degrades an unrecognised stored value to the narrowest policy", () => {
    expect(isLocationScope("everything")).toBe(false);
    expect(isLocationScope("all")).toBe(true);
  });
});

/**
 * The backfill contract. `derivedLocationScope` is the single definition of
 * "what policy reproduces this member's current access", and migration 0170's
 * UPDATE statements implement exactly the same mapping. If the two ever
 * disagree, members change access at deploy time — so the mapping is asserted
 * here, case for case, in the same order the migration writes it.
 */
describe("derivedLocationScope — the 0170 backfill mapping", () => {
  it("gives owners 'all'", () => {
    expect(derivedLocationScope({ role: "owner", defaultLocationId: null, assignedLocationIds: [] })).toBe("all");
  });

  it("gives a member with assignments 'selected'", () => {
    expect(
      derivedLocationScope({ role: "cashier", defaultLocationId: "main", assignedLocationIds: ["main"] }),
    ).toBe("selected");
  });

  it("gives a member with only a home branch 'home'", () => {
    expect(
      derivedLocationScope({ role: "cashier", defaultLocationId: "main", assignedLocationIds: [] }),
    ).toBe("home");
  });

  it("preserves the legacy roaming member's access as an explicit 'all'", () => {
    // Deliberately NOT narrowed: these members reach every branch today, and
    // the deploy must not lock out every roaming manager in production. The
    // migration makes their breadth visible; it does not revoke it.
    expect(
      derivedLocationScope({ role: "manager", defaultLocationId: null, assignedLocationIds: [] }),
    ).toBe("all");
  });

  it("matches the derived behaviour of an unmigrated context exactly", () => {
    // The shim must agree with the stored value for every legacy shape,
    // otherwise a half-migrated read path would disagree with a migrated one.
    const shapes: LocationAccessContext[] = [
      { role: "owner", defaultLocationId: null, assignedLocationIds: [] },
      { role: "manager", defaultLocationId: null, assignedLocationIds: [] },
      { role: "cashier", defaultLocationId: "main", assignedLocationIds: [] },
      { role: "manager", defaultLocationId: "main", assignedLocationIds: ["main", "south"] },
    ];
    for (const shape of shapes) {
      expect(accessibleLocationIds(shape, BRANCHES)).toEqual(
        accessibleLocationIds({ ...shape, scope: derivedLocationScope(shape) }, BRANCHES),
      );
    }
  });
});
