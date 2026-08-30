"use client";

/**
 * Settings — identity, industry, and the public host, side by side.
 * Each is its own save with its own confirmation because they carry very
 * different blast radii (a name is nothing, a timezone is the ledger, a
 * subdomain is everyone's open session).
 */
import { BusinessDetailsPanel, IndustryPanel, SubdomainPanel } from "../panels";

export default function BusinessSettingsPage() {
  return (
    <div className="space-y-4">
      <BusinessDetailsPanel />
      <div className="grid gap-4 xl:grid-cols-2">
        <IndustryPanel />
        <SubdomainPanel />
      </div>
    </div>
  );
}
