/**
 * Navigation visibility is deliberately not authorization. These assertions
 * keep the page-entry guards tied to the same predicates that feed the
 * sidebars, without importing server pages (which would initialise
 * database-only dependencies in this Node test environment).
 *
 * Every contextual app's gate is now expressed in effective *permissions*
 * rather than role strings, so each assertion has a matching negative: the
 * gate must not be fed `session.role`. That negative is the point of the file
 * — a menu that asks a different question from the route behind it is how a
 * member ends up looking at a screen whose every fetch returns 403, or at a
 * missing menu entry for an API that would have served them.
 *
 * `session.role` may still travel into a *view* as presentation (a label, an
 * empty-state hint); what must never come back is an authorization decision
 * made from it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CRM_SECTION_KEYS } from "./(app)/crm/crm-routes";
import { GROWTH_SECTION_KEYS } from "./(app)/growth/growth-routes";
import { WP_SECTION_KEYS } from "./(app)/websites/wp/wp-routes";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("tenant contextual-nav route guards", () => {
  it("has a server-side app-door guard for every contextual app", () => {
    const apps = [
      { path: "./(app)/crm/layout.tsx", gate: "canOpenCrm" },
      { path: "./(app)/growth/layout.tsx", gate: "canOpenGrowth" },
    ] as const;

    for (const app of apps) {
      const page = source(app.path);
      expect(page, `${app.path} must require a signed-in member`).toContain('redirect("/login")');
      expect(page, `${app.path} must resolve effective permissions`).toContain(
        "memberAccessFor(session)",
      );
      expect(page, `${app.path} must enforce ${app.gate}, not only hide nav`).toContain(
        `${app.gate}(permissions)`,
      );
      expect(page, `${app.path} must not gate on a role string`).not.toContain(
        `${app.gate}(session.role)`,
      );
      expect(page, `${app.path} must reject a member without the app`).toContain('redirect("/dashboard")');
    }
  });

  it("still guards the Website app's door", () => {
    // Not yet migrated to the permission model — its gate is still a role
    // predicate, and this asserts it is at least present and server-side.
    const page = source("./(app)/websites/layout.tsx");
    expect(page).toContain('redirect("/login")');
    expect(page).toContain("canOpenWebsiteApp(session.role)");
    expect(page).toContain('redirect("/dashboard")');
  });

  it("has a section-level CRM guard on every canonical page, including Contacts details", () => {
    for (const section of CRM_SECTION_KEYS) {
      const page = source(
        section === "overview"
          ? "./(app)/crm/overview/page.tsx"
          : `./(app)/crm/${section}/page.tsx`,
      );
      expect(page, `/crm/${section} must resolve effective permissions`).toContain(
        "memberAccessFor(session)",
      );
      expect(page, `/crm/${section} must check its own section gate`).toContain(
        `canViewCrmSection(permissions, "${section}")`,
      );
      expect(page).toContain("crmFallbackHref(permissions)");
      expect(page, `/crm/${section} must not re-introduce a role gate`).not.toMatch(
        /(canViewCrmSection|crmFallbackHref|canOpenCrm)\(\s*session\.role/,
      );
    }
    const detail = source("./(app)/crm/persons/[id]/page.tsx");
    expect(detail).toContain('canViewCrmSection(permissions, "persons")');
    expect(detail).toContain("crmFallbackHref(permissions)");
  });

  it("has a permission-based section guard on every canonical Growth page", () => {
    for (const section of GROWTH_SECTION_KEYS) {
      const page = source(
        section === "overview"
          ? "./(app)/growth/overview/page.tsx"
          : `./(app)/growth/${section}/page.tsx`,
      );
      expect(page, `/growth/${section} must resolve effective permissions`).toContain(
        "memberAccessFor(session)",
      );
      expect(page, `/growth/${section} must check its own section gate`).toContain(
        `canViewGrowthSection(permissions, "${section}")`,
      );
      expect(page).toContain("growthFallbackHref(permissions)");
      expect(page, `/growth/${section} must not re-introduce a role gate`).not.toMatch(
        /(canViewGrowthSection|growthFallbackHref|canOpenGrowth)\(\s*session\.role/,
      );
    }
  });

  it("uses the shared Accounting body and Workspace body to enforce their app/feature/permission gates", () => {
    const accounting = source("./(app)/accounting/accounting-page-body.tsx");
    expect(accounting).toContain("memberAccessFor(session)");
    expect(accounting).toContain("canOpenAccounting(permissions)");
    expect(accounting).toContain("canViewAccountingSection(permissions, section)");
    expect(accounting, "the Accounting body must not gate on a role string").not.toMatch(
      /(canOpenAccounting|canViewAccountingSection)\(\s*session\.role/,
    );
    expect(accounting).toContain('requireFeatureForPage(session.businessId, "ledger")');

    const workspace = source("./(app)/workspace/workspace-page-body.tsx");
    expect(workspace).toContain("PERMISSIONS.workspaceView");
    expect(workspace).toContain('redirect("/dashboard")');
  });

  it("protects every WordPress manager entry independently of Website nav visibility", () => {
    for (const section of WP_SECTION_KEYS) {
      const page = source(
        section === "overview"
          ? "./(app)/websites/wp/page.tsx"
          : `./(app)/websites/wp/${section}/page.tsx`,
      );
      expect(page, `/websites/wp/${section} must call the route guard`).toContain(
        `requireWpSection("${section}")`,
      );
    }
  });
});
