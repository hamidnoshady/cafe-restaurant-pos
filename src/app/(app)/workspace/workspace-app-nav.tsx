"use client";

/**
 * My Workspace's contextual sidebar.
 *
 * My Workspace is shared platform functionality, not a fifth business app, but
 * once a member enters `/workspace` the global launcher still gives way to this
 * focused menu. The menu deliberately uses the same AppSectionNav primitive as
 * CRM and Growth: shared navigation behavior and RTL/accessibility treatment,
 * with Workspace-owned route and permission data.
 */

import { WORKSPACE_MODULE_HOME, workspaceSectionHref } from "@/lib/app-routes";
import { AppSectionNav } from "@/app/dashboard/app-section-nav";
import {
  isWorkspaceSectionPathname,
  WORKSPACE_SECTION_GROUPS,
  WORKSPACE_SECTION_META,
  type WorkspaceSection,
} from "./workspace-routes";

export interface WorkspaceSidebarSection {
  key: WorkspaceSection;
  label: string;
  description: string;
}

export function WorkspaceAppNav({
  pathname,
  sections,
  onNavigate,
}: {
  pathname: string;
  /** Already permission-filtered by WorkspaceShell on the server. */
  sections: readonly WorkspaceSidebarSection[];
  onNavigate: () => void;
}) {
  const visible = new Set(sections.map((section) => section.key));

  return (
    <AppSectionNav<WorkspaceSection>
      ariaLabel="بخش‌های میز کار من"
      title="میز کار من"
      description="پروژه‌ها، کارها، اسناد و قراردادهای اجرایی"
      items={sections.map((section) => ({
        ...section,
        icon: WORKSPACE_SECTION_META[section.key].icon,
      }))}
      groups={WORKSPACE_SECTION_GROUPS.map((group) => ({
        label: group.label,
        keys: group.keys.filter((key) => visible.has(key)),
      }))}
      hrefFor={(key) => (key === "overview" ? WORKSPACE_MODULE_HOME : workspaceSectionHref(key))}
      isActive={(key) => isWorkspaceSectionPathname(pathname, key)}
      onNavigate={onNavigate}
    />
  );
}
