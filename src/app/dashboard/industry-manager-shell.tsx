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
 */
import type { ReactNode } from "react";
import { ErrorBox } from "./ui";

/**
 * How a section runs a mutation: the manager owns `busy`, the error message and
 * reloading, so a section only says what to call. Returns whether it succeeded,
 * so the section can clear its own form.
 */
export type Runner = (
  fn: () => Promise<{ ok: boolean; data: { error?: string; message?: string } }>,
) => Promise<boolean>;

export interface ManagerTab<K extends string> {
  key: K;
  label: string;
}

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

      <nav
        aria-label={navLabel}
        className="rounded-2xl border border-stone-200/80 bg-white p-2 shadow-[0_1px_2px_rgb(41_37_36/0.03)]"
      >
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                id={`${idPrefix}-tab-${tab.key}`}
                type="button"
                aria-pressed={isActive}
                aria-controls={`${idPrefix}-tabpanel`}
                onClick={() => onTabChange(tab.key)}
                className={`min-h-[52px] rounded-xl border px-3 text-center text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-amber-400/40 sm:px-4 ${
                  isActive
                    ? "border-amber-200 bg-amber-100 text-amber-950 shadow-[0_1px_2px_rgb(120_53_15/0.08)]"
                    : "border-transparent bg-transparent text-stone-600 hover:border-stone-200 hover:bg-stone-50 hover:text-stone-950"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </nav>

      <div
        id={`${idPrefix}-tabpanel`}
        role="region"
        aria-labelledby={`${idPrefix}-tab-${activeTab}`}
        className="min-w-0"
      >
        {children}
      </div>
    </div>
  );
}
