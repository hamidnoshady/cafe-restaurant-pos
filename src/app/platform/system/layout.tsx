"use client";

/**
 * The system section shell: «سلامت» (this deployment's database/migration
 * state) and «پایش» (OpenObserve — process logs, errors, slow requests,
 * across every host feeding the collector). Same SubNav pattern as the AI
 * section, so the sidebar nests the pair and mobile gets a tab strip.
 */
import { SubNav } from "../ui";

export default function SystemSectionLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <SubNav
        items={[
          { label: "سلامت", href: "/platform/system", exact: true },
          { label: "پایش", href: "/platform/system/logs" },
        ]}
      />
      {children}
    </div>
  );
}
