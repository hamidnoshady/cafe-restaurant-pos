import { NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { requireCoworkerFeature } from "@/lib/coworker-api-guard";
import { isModuleEnabled } from "@/lib/industry-guard";
import type { ModuleKey } from "@/lib/industry-profile";
import { COWORKER_TEMPLATE_LIST, WASTE_REASON_OPTIONS } from "@/lib/ai-coworker-templates";
import {
  COWORKER_APPROVAL_LABELS,
  COWORKER_EVENT_LABELS,
  COWORKER_TRIGGER_LABELS,
} from "@/lib/ai-coworker";

/**
 * Phase 32 — the ready-made job catalogue, for a sub app that wants to offer
 * the same "put the coworker to work" flow the dashboard does. Narrowed to the
 * trade's own modules, exactly as the dashboard route is.
 */
export const GET = withApiKeyScope(async (apiKey) => {
  const denied = requireApiScope(apiKey.scopes, API_SCOPES.coworkerRead);
  if (denied) return denied;
  const locked = await requireCoworkerFeature(apiKey.businessId);
  if (locked) return locked;

  const templates = [];
  for (const template of COWORKER_TEMPLATE_LIST) {
    if (!(await isModuleEnabled(apiKey.businessId, template.module as ModuleKey))) continue;
    templates.push(template);
  }
  return NextResponse.json({
    templates,
    labels: {
      triggers: COWORKER_TRIGGER_LABELS,
      events: COWORKER_EVENT_LABELS,
      approval: COWORKER_APPROVAL_LABELS,
      wasteReasons: WASTE_REASON_OPTIONS,
    },
  });
});
