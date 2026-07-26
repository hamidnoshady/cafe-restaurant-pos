import { describe, expect, it } from "vitest";
import { MAX_SLUG_LENGTH, slugifyBusinessName, uniqueSlug } from "./slug";

describe("slugifyBusinessName", () => {
  it("slugifies Latin names", () => {
    expect(slugifyBusinessName("Alpha Cafe")).toBe("alpha-cafe");
    expect(slugifyBusinessName("  Beta   Restaurant  ")).toBe("beta-restaurant");
    expect(slugifyBusinessName("Cafe_Noir")).toBe("cafe-noir");
  });

  it("keeps Persian names instead of stripping them to nothing", () => {
    // The whole point: an ASCII-only slugifier would return "" for every
    // business in the product's actual market.
    expect(slugifyBusinessName("کافه نادری")).toBe("کافه-نادری");
    expect(slugifyBusinessName("رستوران شاندیز")).toBe("رستوران-شاندیز");
  });

  it("normalises Persian digits and interchangeable Arabic letters", () => {
    // "کافه۱" and "کافه1" are the same business typed two ways.
    expect(slugifyBusinessName("کافه۱")).toBe(slugifyBusinessName("کافه1"));
    // ي/ى (Arabic yeh) vs ی (Persian yeh), and ك vs ک.
    expect(slugifyBusinessName("كافي")).toBe(slugifyBusinessName("کافی"));
  });

  it("drops punctuation and collapses separators", () => {
    expect(slugifyBusinessName("Joe's Diner & Grill!")).toBe("joes-diner-grill");
    expect(slugifyBusinessName("--a--b--")).toBe("a-b");
  });

  it("returns empty for a name with nothing usable, rather than a silent default", () => {
    expect(slugifyBusinessName("!!!")).toBe("");
    expect(slugifyBusinessName("   ")).toBe("");
  });

  it("truncates without leaving a trailing hyphen", () => {
    const slug = slugifyBusinessName("a".repeat(80));
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("uniqueSlug", () => {
  it("returns the base when it is free", () => {
    expect(uniqueSlug("alpha-cafe", [])).toBe("alpha-cafe");
    expect(uniqueSlug("alpha-cafe", ["beta-cafe"])).toBe("alpha-cafe");
  });

  it("appends a readable counter on collision", () => {
    expect(uniqueSlug("alpha", ["alpha"])).toBe("alpha-2");
    expect(uniqueSlug("alpha", ["alpha", "alpha-2", "alpha-3"])).toBe("alpha-4");
  });

  it("compares case-insensitively, matching the citext column", () => {
    expect(uniqueSlug("alpha", ["ALPHA"])).toBe("alpha-2");
  });

  it("falls back when the base is empty", () => {
    expect(uniqueSlug("", [])).toBe("biz");
    expect(uniqueSlug("", ["biz"])).toBe("biz-2");
  });

  it("leaves room for the counter when the base is at the length limit", () => {
    const long = "a".repeat(MAX_SLUG_LENGTH);
    const result = uniqueSlug(long, [long.slice(0, MAX_SLUG_LENGTH - 4)]);
    expect(result.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(result.endsWith("-2")).toBe(true);
  });
});
