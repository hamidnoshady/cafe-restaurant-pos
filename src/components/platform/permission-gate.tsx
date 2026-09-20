"use client";

import * as React from "react";
import type { PlatformCapability } from "@/lib/platform-admin";
import { useCapabilities } from "@/app/platform/_lib/capability-context";

/**
 * Hide UI an operator's role could never use. This is UI honesty ONLY — never
 * the authorization boundary (section 24): every write API re-checks the
 * capability server-side. `require` accepts one capability or a list; `mode`
 * decides whether all or any are needed (default: any).
 */
export function PermissionGate({
  require,
  mode = "any",
  fallback = null,
  children,
}: {
  require: PlatformCapability | PlatformCapability[];
  mode?: "any" | "all";
  fallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  const caps = useCapabilities();
  const list = Array.isArray(require) ? require : [require];
  const allowed =
    mode === "all" ? list.every((c) => caps.includes(c)) : list.some((c) => caps.includes(c));
  return <>{allowed ? children : fallback}</>;
}
