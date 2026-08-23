"use client";

/**
 * Phase 25 Wave 4 — the chrome the three industry manager pages share.
 *
 * `jewelry-manager.tsx`, `watch-manager.tsx` and `accessories-manager.tsx` were
 * written one per wave and ended up as three copies of the same thing: an error
 * box, a tab strip with identical markup and classes, a labelled region for the
 * active tab, and the same `Runner` callback shape passed down to every
 * section. Only the tab list and the sections differ. Keeping three copies
 * meant a fix to the tab strip's focus ring or its ARIA wiring had to be made
 * three times — and, as of this wave, a fourth if another industry is added.
 *
 * The tab strip itself is now `<TabBar>` (page-chrome.tsx), shared with every
 * other tabbed screen in the dashboard. What is left here is the industry
 * managers' own contract: the `Runner` shape and the error box above the strip.
 */
import type { ReactNode } from "react";
import { TabBar, TabPanel, type Tab } from "./page-chrome";
import { ErrorBox } from "./ui";

/**
 * How a section runs a mutation: the manager owns `busy`, the error message and
 * reloading, so a section only says what to call. Returns whether it succeeded,
 * so the section can clear its own form.
 */
export type Runner = (
  fn: () => Promise<{ ok: boolean; data: { error?: string; message?: string } }>,
) => Promise<boolean>;

export type ManagerTab<K extends string> = Tab<K>;

export function IndustryManagerShell<K extends string>({
  /** Prefixes the tab and panel element ids, so several shells could coexist on a page. */
  idPrefix,
  navLabel,
  tabs,
  activeTab,
  onTabChange,
  error,
  children,
}: {
  idPrefix: string;
  navLabel: string;
  tabs: readonly ManagerTab<K>[];
  activeTab: K;
  onTabChange: (tab: K) => void;
  error: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>
      <TabBar idPrefix={idPrefix} label={navLabel} tabs={tabs} active={activeTab} onChange={onTabChange} />
      <TabPanel idPrefix={idPrefix} active={activeTab}>
        {children}
      </TabPanel>
    </div>
  );
}
