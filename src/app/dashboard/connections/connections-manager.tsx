"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FeatureLock } from "@/components/feature-lock";
import type { ConnectionKind, ConnectionKindKey } from "@/lib/connection-kinds";
import { DesktopPanel } from "./desktop-panel";
import { WooCommercePanel } from "./woocommerce-panel";
import { ApiTokensPanel } from "./api-tokens-panel";

/**
 * The hub's tab shell.
 *
 * The active tab is mirrored into `?tab=` (via `replace`, so it does not stack
 * history entries) for one concrete reason: this is a screen people are sent
 * links to — "go to Connections → Desktop and press generate" is the support
 * answer to the failure this whole area was rebuilt for — and a tab that
 * cannot be linked to makes that instruction two steps longer.
 */
export function ConnectionsManager({
  kinds,
  initialTab,
  features,
}: {
  kinds: ConnectionKind[];
  initialTab: ConnectionKindKey;
  features: Record<string, boolean>;
}) {
  const router = useRouter();
  const [active, setActive] = useState<ConnectionKindKey>(initialTab);
  const activeKind = kinds.find((kind) => kind.key === active) ?? kinds[0];

  function select(key: ConnectionKindKey) {
    setActive(key);
    router.replace(`/dashboard/connections?tab=${key}`, { scroll: false });
  }

  // A tab whose feature is off still renders — as an inert preview — so a
  // business can see what it would be buying. See connection-kinds.ts.
  const locked = Boolean(activeKind.feature && !features[activeKind.feature]);

  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="نوع اتصال" className="flex flex-wrap gap-2">
        {kinds.map((kind) => (
          <button
            key={kind.key}
            type="button"
            role="tab"
            aria-selected={kind.key === active}
            onClick={() => select(kind.key)}
            className={`rounded-full px-4 py-2 text-sm font-medium transition ${
              kind.key === active
                ? "bg-stone-900 text-white"
                : "border border-stone-200 bg-card text-stone-700 hover:border-stone-400"
            }`}
          >
            {kind.label}
          </button>
        ))}
      </div>

      <p className="text-sm leading-6 text-muted-foreground">{activeKind.description}</p>

      <FeatureLock locked={locked} title={activeKind.label}>
        {active === "desktop" ? <DesktopPanel /> : null}
        {active === "woocommerce" ? <WooCommercePanel /> : null}
        {active === "api" ? <ApiTokensPanel /> : null}
      </FeatureLock>
    </div>
  );
}
