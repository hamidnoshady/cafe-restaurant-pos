"use client";

import { usePathname } from "next/navigation";
import { AiAssistant } from "@/components/ai/ai-assistant";
import { STEPS } from "./steps";

/** Wizard-mode assistant: derives the current step from the URL so the agent
 *  focuses on the step the user is on. */
export function SetupAssistant() {
  const pathname = usePathname();
  const step = STEPS.find((s) => pathname?.startsWith(s.path))?.id ?? null;
  return <AiAssistant mode="wizard" currentStep={step} />;
}
