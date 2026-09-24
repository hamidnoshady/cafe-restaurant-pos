/**
 * Navigation visibility is deliberately not authorization. These assertions
 * keep the page-entry guards tied to the same role/permission predicates that
 * feed the sidebars, without importing server pages (which would initialise
 * database-only dependencies in this Node test environment).
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
      { path: "./(app)/websites/layout.tsx", gate: "canOpenWebsiteApp" },
    ] as const;

    for (const app of apps) {
      const page = source(app.path);
      expect(page, `${app.path} must require a signed-in member`).toContain('redirect("/login")');
      expect(page, `${app.path} must enforce ${app.gate}, not only hide nav`).toContain(
        `${app.gate}(session.role)`,
      );
      expect(page, `${app.path} must reject a member without the app`).toContain('redirect("/dashboard")');
    }
  });

  it("has a section-level CRM guard on every canonical page, including Contacts details", () => {
    for (const section of CRM_SECTION_KEYS) {
      const page = source(
        section === "overview"
          ? "./(app)/crm/overview/page.tsx"
          : `./(app)/crm/${section}/page.tsx`,
      );
      expect(page, `/crm/${section} must check its own section gate`).toContain(
        `canViewCrmSection(session.role, "${section}")`,
      );
      expect(page).toContain("crmFallbackHref(session.role)");
    }
    const detail = source("./(app)/crm/persons/[id]/page.tsx");
    expect(detail).toContain('canViewCrmSection(session.role, "persons")');
    expect(detail).toContain("crmFallbackHref(session.role)");
  });

  it("has a section-level Growth guard on every canonical page", () => {
    for (const section of GROWTH_SECTION_KEYS) {
      const page = source(
        section === "overview"
          ? "./(app)/growth/overview/page.tsx"
          : `./(app)/growth/${section}/page.tsx`,
      );
      expect(page, `/growth/${section} must check its own section gate`).toContain(
        `canViewGrowthSection(session.role, "${section}")`,
      );
      expect(page).toContain("growthFallbackHref(session.role)");
    }
  });

  it("uses the shared Accounting body and Workspace body to enforce their app/feature/permission gates", () => {
    const accounting = source("./(app)/accounting/accounting-page-body.tsx");
    expect(accounting).toContain("canOpenAccounting(session.role)");
    expect(accounting).toContain("canViewAccountingSection(session.role, section)");
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
