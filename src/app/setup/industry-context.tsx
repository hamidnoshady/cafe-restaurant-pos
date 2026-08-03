"use client";

import { createContext, useContext } from "react";
import type { Industry } from "@/lib/industries";

const SetupIndustryContext = createContext<Industry>("food_service");

/**
 * The wizard's business industry, resolved once server-side in
 * setup/layout.tsx (`getBusinessIndustry`, the same helper the jewelry
 * dashboard page's guard uses) and handed down via context so every step
 * page/StepShell/StepNav can filter its step list (`steps.ts`'s `stepsFor`)
 * without each one re-fetching it.
 */
export function SetupIndustryProvider({
  industry,
  children,
}: {
  industry: Industry;
  children: React.ReactNode;
}) {
  return <SetupIndustryContext.Provider value={industry}>{children}</SetupIndustryContext.Provider>;
}

export function useSetupIndustry(): Industry {
  return useContext(SetupIndustryContext);
}
