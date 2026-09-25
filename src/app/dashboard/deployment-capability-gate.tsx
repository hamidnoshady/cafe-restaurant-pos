"use client";

import { usePathname } from "next/navigation";
import type { DeploymentProfile } from "@/lib/deployment-mode";
import { resolveCapability, type CapabilityKey } from "@/lib/capabilities";
import { CloudRequiredState } from "@/components/cloud-required-state";

const PAGE_CAPABILITIES: readonly [string, CapabilityKey, string][] = [
  ["/growth", "app.growth", "رشد و بازاریابی"],
  ["/websites", "app.website", "مدیریت وب‌سایت"],
  // /dashboard is the assistant home in this repository. Match exactly so
  // operational children that may still redirect through /dashboard/* are not
  // accidentally classified as AI.
  ["/dashboard", "app.ai", "دستیار هوشمند"],
];

export function DeploymentCapabilityGate({
  profile,
  children,
}: {
  profile: DeploymentProfile;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const match = PAGE_CAPABILITIES.find(([prefix]) =>
    prefix === "/dashboard" ? pathname === prefix : pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!match) return <>{children}</>;
  const resolution = resolveCapability(match[1], { deployment: profile });
  if (resolution.status === "requires_cloud") return <CloudRequiredState featureName={match[2]} />;
  return <>{children}</>;
}
