import { describe, expect, it } from "vitest";
import {
  MAX_SLUG_LENGTH,
  RESERVED_SLUGS,
  slugifyBusinessName,
  subdomainFromBusinessName,
  uniqueSlug,
  validateSubdomain,
} from "./slug";

describe("slugifyBusinessName", () => {
  it("slugifies Latin names", () => {
    expect(slugifyBusinessName("Alpha Cafe")).toBe("alpha-cafe");
    expect(slugifyBusinessName("  Beta   Restaurant  ")).toBe("beta-restaurant");
    expect(slugifyBusinessName("Cafe_Noir")).toBe("cafe-noir");
  });

  it("transliterates Persian names to a Latin slug instead of stripping them to nothing", () => {
    // The whole point: an ASCII-only slugifier with no transliteration would
    // return "" for every business in the product's actual market, and a slug
    // that just keeps the Persian text with hyphens isn't an "english name".
    expect(slugifyBusinessName("کافه نادری")).toBe("kafh-nadry");
    expect(slugifyBusinessName("رستوران شاندیز")).toBe("rstvran-shandyz");
    expect(slugifyBusinessName("چایخانه تی تی")).toBe("chaykhanh-ty-ty");
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

  it("never hands out a slug that collides with a top-level app route", () => {
    for (const reserved of RESERVED_SLUGS) {
      expect(uniqueSlug(reserved, [])).toBe(`${reserved}-2`);
    }
  });
});

describe("validateSubdomain", () => {
  it("accepts an ordinary DNS label", () => {
    expect(validateSubdomain("acme")).toBe(null);
    expect(validateSubdomain("acme-cafe")).toBe(null);
    expect(validateSubdomain("cafe123")).toBe(null);
  });

  it("accepts the biz-xxxxxxxx labels migration 0066 backfilled", () => {
    expect(validateSubdomain("biz-1a2b3c4d")).toBe(null);
  });

  it("normalises case and surrounding whitespace before judging", () => {
    expect(validateSubdomain("  ACME  ")).toBe(null);
  });

  it("rejects anything outside the DNS label charset", () => {
    expect(validateSubdomain("acme_cafe")).toBe("invalid_subdomain");
    expect(validateSubdomain("acme.cafe")).toBe("invalid_subdomain");
    expect(validateSubdomain("کافه")).toBe("invalid_subdomain");
    expect(validateSubdomain("acme cafe")).toBe("invalid_subdomain");
  });

  it("enforces the 3–63 character bounds a DNS label actually has", () => {
    expect(validateSubdomain("ab")).toBe("invalid_subdomain");
    expect(validateSubdomain("abc")).toBe(null);
    expect(validateSubdomain("a".repeat(63))).toBe(null);
    expect(validateSubdomain("a".repeat(64))).toBe("invalid_subdomain");
  });

  it("rejects a leading or trailing hyphen, which is illegal in a hostname", () => {
    expect(validateSubdomain("-acme")).toBe("invalid_subdomain");
    expect(validateSubdomain("acme-")).toBe("invalid_subdomain");
  });

  it("rejects the punycode prefix shape, which resolvers read as an IDN", () => {
    expect(validateSubdomain("xn--80ak6aa92e")).toBe("invalid_subdomain");
    expect(validateSubdomain("ab--cd")).toBe("invalid_subdomain");
    // Hyphens elsewhere are fine — only positions 3-4 carry that meaning.
    expect(validateSubdomain("abc--de")).toBe(null);
  });

  it("rejects the labels the deployment answers on itself", () => {
    for (const reserved of ["admin", "www", "api", "app", "mail", "platform"]) {
      expect(validateSubdomain(reserved), reserved).toBe("reserved_subdomain");
    }
  });
});

describe("subdomainFromBusinessName", () => {
  it("derives a label from a Persian name, transliterated like the slug", () => {
    expect(subdomainFromBusinessName("کافه آرام")).toBe(slugifyBusinessName("کافه آرام"));
  });

  it("returns empty when the derived label is not a usable DNS label", () => {
    // Two characters is a valid slug but not a valid subdomain, so the caller
    // gets "" and decides — rather than being handed an unusable host.
    expect(subdomainFromBusinessName("ab")).toBe("");
    // Reserved: a business called "Admin" must not shadow the console's host.
    expect(subdomainFromBusinessName("Admin")).toBe("");
    expect(subdomainFromBusinessName("!!!")).toBe("");
  });

  it("stays inside the DNS label limit for any length of name", () => {
    // A derived label inherits slugifyBusinessName's own MAX_SLUG_LENGTH cap,
    // which is well under the 63-character DNS bound — that bound is what a
    // hand-typed subdomain is checked against, not what derivation produces.
    const result = subdomainFromBusinessName("a".repeat(200));
    expect(result.length).toBe(MAX_SLUG_LENGTH);
    expect(validateSubdomain(result)).toBe(null);
  });
});
