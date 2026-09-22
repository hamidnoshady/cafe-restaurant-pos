"use client";

/**
 * The «میز کار من» rail and the section it opens.
 *
 * Each section is a real URL (`/workspace/tasks`), so the rail *navigates*
 * rather than switching local state: a member can bookmark the section they
 * live in, the AI assistant can link straight to it, and the back button walks
 * sections the way it walks every other page. That is the same arrangement
 * `settings-manager.tsx` uses, down to the phone drill-down, because this
 * module is platform furniture of exactly that shape — not a fifth app.
 *
 * The lookups (members, parties, projects, media files) are fetched ONCE here
 * and passed down, so switching sections does not re-fetch the same three
 * pickers, and so a section component never has to know how to find a party.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { WORKSPACE_MODULE_HOME, workspaceSectionHref } from "@/lib/app-routes";
import { PERMISSIONS } from "@/lib/permissions";
import { SectionNav, type Section } from "@/app/dashboard/section-nav";
import { useWorkspaceLookups } from "./use-workspace-lookups";
import {
  WORKSPACE_SECTION_GROUPS,
  WORKSPACE_SECTION_META,
  visibleWorkspaceSections,
  type WorkspaceSection,
} from "./workspace-routes";
import { OverviewSection } from "./overview-section";
import { ProjectsSection } from "./projects-section";
import { TasksSection } from "./tasks-section";
import { CalendarSection } from "./calendar-section";
import { DocumentsSection } from "./documents-section";
import { ContractsSection } from "./contracts-section";
import { TeamsSection } from "./teams-section";
import { ApprovalsSection } from "./approvals-section";
import { ReportsSection } from "./reports-section";
import { TemplatesSection } from "./templates-section";

/**
 * No `currentUserId` prop: every "mine" filter in this module is answered on
 * the server from the session (`?mine=true` never carries a user id), because
 * a "whose?" question a client can rewrite is not a filter, it is a leak.
 */
export function WorkspaceManager({
  activeSection,
  permissions,
}: {
  activeSection: WorkspaceSection;
  permissions: readonly string[];
}) {
  const router = useRouter();
  const lookups = useWorkspaceLookups();

  const held = useMemo(() => new Set(permissions), [permissions]);
  const canManage = held.has(PERMISSIONS.workspaceManage);
  const canManageContracts = held.has(PERMISSIONS.workspaceContractsManage);
  const canApprove = held.has(PERMISSIONS.workspaceApprove);

  const visible = useMemo(() => visibleWorkspaceSections(held), [held]);
  const sections = useMemo<Section<WorkspaceSection>[]>(
    () => visible.map((meta) => ({ key: meta.key, label: meta.label, icon: meta.icon })),
    [visible],
  );
  const groups = useMemo(
    () =>
      WORKSPACE_SECTION_GROUPS.map((group) => ({
        label: group.label,
        keys: group.keys.filter((key) => visible.some((meta) => meta.key === key)),
      })).filter((group) => group.keys.length > 0),
    [visible],
  );

  // A phone opens straight into the section the URL named and shows the list
  // at the module home — the drill-down decided by the address, not by a click
  // that may never have happened.
  const [open, setOpen] = useState(activeSection !== "overview");
  useEffect(() => {
    setOpen(activeSection !== "overview");
  }, [activeSection]);

  const goToSection = useCallback(
    (key: WorkspaceSection) => {
      setOpen(true);
      router.push(workspaceSectionHref(key));
    },
    [router],
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      // On a phone the back bar is a real return to the section list; keep the
      // address honest so a refresh does not reopen the section behind it.
      if (!next && activeSection !== "overview") router.replace(WORKSPACE_MODULE_HOME);
    },
    [activeSection, router],
  );

  return (
    <SectionNav
      idPrefix="workspace"
      label="بخش‌های میز کار"
      description="یک بخش را برای کار انتخاب کنید."
      variant="rail"
      sections={sections}
      groups={groups}
      active={activeSection}
      onChange={goToSection}
      open={open}
      onOpenChange={handleOpenChange}
    >
      {activeSection === "overview" ? <OverviewSection /> : null}
      {activeSection === "projects" ? (
        <ProjectsSection lookups={lookups} canManage={canManage} />
      ) : null}
      {activeSection === "tasks" ? (
        <TasksSection lookups={lookups} canManage={canManage} />
      ) : null}
      {activeSection === "calendar" ? (
        <CalendarSection lookups={lookups} canManage={canManage} />
      ) : null}
      {activeSection === "documents" ? (
        <DocumentsSection
          lookups={lookups}
          canManage={canManage}
          canRequestApproval={canManage}
        />
      ) : null}
      {activeSection === "contracts" ? (
        <ContractsSection
          lookups={lookups}
          canManageContracts={canManageContracts}
          canRequestApproval={canManage}
        />
      ) : null}
      {activeSection === "teams" ? (
        <TeamsSection lookups={lookups} canManage={canManage} />
      ) : null}
      {activeSection === "approvals" ? <ApprovalsSection canApprove={canApprove} /> : null}
      {activeSection === "reports" ? <ReportsSection /> : null}
      {activeSection === "templates" ? <TemplatesSection canManage={canManage} /> : null}
    </SectionNav>
  );
}
