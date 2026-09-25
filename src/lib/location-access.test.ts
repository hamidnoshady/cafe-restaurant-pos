import { describe, expect, it } from "vitest";
import {
  accessibleLocationIds,
  canAccessLocation,
  canSwitchBranches,
  defaultAccessibleLocationId,
  type LocationAccessContext,
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
    // Compatibility for a pre-migration fixture. Migration 0170 persists
    // this inferred result as an explicit `all` policy.
    expect(accessibleLocationIds(ctx({}), BRANCHES)).toEqual(BRANCHES);
    expect(accessibleLocationIds(ctx({}), ["only-branch"])).toEqual(["only-branch"]);
  });

  it("honours every explicit branch policy without fallback broadening", () => {
    expect(accessibleLocationIds(ctx({ locationScope: "all" }), BRANCHES)).toEqual(BRANCHES);
    expect(accessibleLocationIds(ctx({ locationScope: "none" }), BRANCHES)).toEqual([]);
    expect(accessibleLocationIds(ctx({ locationScope: "selected" }), BRANCHES)).toEqual([]);
    expect(
      accessibleLocationIds(
        ctx({ locationScope: "selected", assignedLocationIds: ["south", "foreign"] }),
        BRANCHES,
      ),
    ).toEqual(["south"]);
    expect(
      accessibleLocationIds(ctx({ locationScope: "home", defaultLocationId: "north" }), BRANCHES),
    ).toEqual(["north"]);
    expect(accessibleLocationIds(ctx({ locationScope: "home" }), BRANCHES)).toEqual([]);
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
