"use client";

/**
 * The signed-in platform admin's capability list, provided once by the console
 * shell and read by any page/component to keep the UI honest (hide controls the
 * operator's role could not use). The server still re-checks every write; this
 * is never the authorization boundary.
 */
import { createContext, useContext } from "react";
import type { PlatformCapability } from "@/lib/platform-admin";

export const CapabilityContext = createContext<PlatformCapability[]>([]);

export function useCapabilities(): PlatformCapability[] {
  return useContext(CapabilityContext);
}

/** A predicate helper: `const can = useCan(); can("billing.manage")`. */
export function useCan(): (cap: PlatformCapability) => boolean {
  const caps = useCapabilities();
  return (cap) => caps.includes(cap);
}
