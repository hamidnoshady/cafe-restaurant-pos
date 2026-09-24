import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sidebarSource = readFileSync(
  fileURLToPath(new URL("./dashboard-sidebar.tsx", import.meta.url)),
  "utf8",
);
const workspaceManagerSource = readFileSync(
  fileURLToPath(new URL("../(app)/workspace/workspace-manager.tsx", import.meta.url)),
  "utf8",
);
const websiteNavSource = readFileSync(
  fileURLToPath(new URL("../(app)/websites/website-app-nav.tsx", import.meta.url)),
  "utf8",
);

describe("tenant navigation architecture", () => {
  it("uses the canonical Workspace root for contextual navigation", () => {
    expect(sidebarSource).toContain("isWorkspacePathname(pathname)");
    expect(sidebarSource).not.toContain('pathname.startsWith("/projects")');
    expect(sidebarSource).not.toContain("showWorkspaceRail");
  });

  it("has no abandoned app-nav filtering branch or Accounting exception", () => {
    expect(sidebarSource).not.toContain("appNavItems");
    expect(sidebarSource).not.toContain('appShell.shell.app !== "accounting"');
    expect(sidebarSource).toContain("<WorkspaceNavigation pathname={pathname} sections={workspaceSections} />");
  });

  it("does not render a second permanent Workspace rail inside the page", () => {
    expect(workspaceManagerSource).not.toContain("<SectionNav");
    expect(workspaceManagerSource).not.toContain("useRouter");
    expect(workspaceManagerSource).toContain("Workspace navigation lives in the tenant shell");
  });

  it("uses the shared contextual-nav primitive for Website Management", () => {
    expect(websiteNavSource).toContain("<AppSectionNav<WebsiteNavKey>");
    expect(websiteNavSource).not.toContain("function CollapsibleNavGroup");
  });
});
