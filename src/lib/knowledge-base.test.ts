import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_SECTIONS,
  isKnownKnowledgeSection,
  knowledgeSection,
  parseKnowledgeUrl,
  sectionForPathname,
} from "./knowledge-base";

describe("KNOWLEDGE_SECTIONS", () => {
  it("has a unique key per section", () => {
    const keys = KNOWLEDGE_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has a unique route per section", () => {
    const routes = KNOWLEDGE_SECTIONS.map((s) => s.route);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("labels are non-empty Persian display names", () => {
    for (const section of KNOWLEDGE_SECTIONS) {
      expect(section.label.trim().length).toBeGreaterThan(0);
      // A section's route is a real public page: either a remaining workspace
      // surface or an app-first canonical route.
      expect(section.route.startsWith("/")).toBe(true);
      expect(section.route).not.toContain("?");
    }
  });
});

describe("knowledgeSection / isKnownKnowledgeSection", () => {
  it("finds a known key", () => {
    expect(knowledgeSection("pos")?.route).toBe("/accounting/pos");
    expect(isKnownKnowledgeSection("pos")).toBe(true);
  });

  it("rejects an unknown key", () => {
    expect(knowledgeSection("nope")).toBeUndefined();
    expect(isKnownKnowledgeSection("nope")).toBe(false);
  });
});

describe("sectionForPathname", () => {
  it("matches an exact route", () => {
    expect(sectionForPathname("/crm/directory")?.key).toBe("customers");
  });

  it("resolves the longest route, so a growth subpage beats the growth home", () => {
    expect(sectionForPathname("/growth")?.key).toBe("growth");
    expect(sectionForPathname("/growth/loyalty")?.key).toBe("loyalty");
    expect(sectionForPathname("/growth/gift-cards")?.key).toBe("gift-cards");
  });

  it("keeps a section's own sub-routes (an order detail stays the orders section)", () => {
    expect(
      sectionForPathname(
        "/accounting/orders/01234567-0000-0000-0000-000000000000",
      )?.key,
    ).toBe("orders");
  });

  it("returns undefined for routes the catalogue does not know", () => {
    expect(sectionForPathname("/dashboard")).toBeUndefined();
    expect(sectionForPathname("/login")).toBeUndefined();
    // …and for a route that merely shares a prefix without the trailing slash.
    expect(sectionForPathname("/dashboard/positional")).toBeUndefined();
  });
});

describe("parseKnowledgeUrl", () => {
  it("accepts http and https URLs, trimmed", () => {
    expect(parseKnowledgeUrl("https://help.example.com/pos")).toEqual({
      ok: true,
      url: "https://help.example.com/pos",
    });
    expect(parseKnowledgeUrl("  https://help.example.com/pos  ")).toEqual({
      ok: true,
      url: "https://help.example.com/pos",
    });
    expect(parseKnowledgeUrl("http://localhost:3000/pos")).toEqual({
      ok: true,
      url: "http://localhost:3000/pos",
    });
  });

  it("rejects empty, non-http and garbage input", () => {
    expect(parseKnowledgeUrl("")).toEqual({ ok: false, error: "invalid_url" });
    expect(parseKnowledgeUrl("   ")).toEqual({
      ok: false,
      error: "invalid_url",
    });
    expect(parseKnowledgeUrl("example.com/pos")).toEqual({
      ok: false,
      error: "invalid_url",
    });
    expect(parseKnowledgeUrl("ftp://help.example.com/pos")).toEqual({
      ok: false,
      error: "invalid_url",
    });
    expect(parseKnowledgeUrl("javascript:alert(1)")).toEqual({
      ok: false,
      error: "invalid_url",
    });
    expect(parseKnowledgeUrl(null)).toEqual({
      ok: false,
      error: "invalid_url",
    });
    expect(parseKnowledgeUrl(42)).toEqual({ ok: false, error: "invalid_url" });
  });
});
