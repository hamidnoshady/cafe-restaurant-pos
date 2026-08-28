import { describe, expect, it } from "vitest";
import { matchProfile, profileForKey, HOLOO_PROFILES } from "./schema-profile";

describe("matchProfile", () => {
  it("matches the canonical Holoo layout when every core table is present", () => {
    const profile = matchProfile(["Goods", "Person", "Account", "Invoice", "InvoiceItem", "Sanad", "SanadRow"]);
    expect(profile?.key).toBe("holoo-generic");
  });

  it("is case-insensitive on table names", () => {
    const profile = matchProfile(["goods", "person", "account", "invoice", "sanad"]);
    expect(profile?.key).toBe("holoo-generic");
  });

  it("returns null when a core table is missing (unknown edition)", () => {
    // No journal table — a structure we have not catalogued.
    expect(matchProfile(["Goods", "Person", "Account", "Invoice"])).toBeNull();
    expect(matchProfile(["Foo", "Bar"])).toBeNull();
    expect(matchProfile([])).toBeNull();
  });
});

describe("profileForKey", () => {
  it("returns the profile for a known key and null otherwise", () => {
    expect(profileForKey("holoo-generic")?.label).toBe(HOLOO_PROFILES[0].label);
    expect(profileForKey("nope")).toBeNull();
  });
});
