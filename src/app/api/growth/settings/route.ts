import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { businessToday } from "@/lib/business-day-service";
import { listCommissionRules } from "@/lib/commission-service";
import { classifyCampaign, type CampaignState } from "@/lib/growth-shared";
import { listPrograms } from "@/lib/loyalty-service";
import { listMessageTemplates } from "@/lib/message-campaigns-service";
import { getPublicMessageConfig } from "@/lib/messaging-billing";
import { listPromotionCatalogue } from "@/lib/promotions-service";

/**
 * A concise, read-only snapshot for Growth's settings home.
 *
 * This is intentionally an overview rather than a second set of mutation
 * endpoints. Loyalty, campaigns, message templates and commission rules each
 * already have an operational screen that owns its editor. Reporting their
 * current state here lets an owner find a missing default or an unavailable
 * sender before following the clearly labelled link to that owner screen.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const [today, programs, promotions, templates, messaging, commissionRules] = await Promise.all([
    businessToday(session.businessId),
    listPrograms(session.businessId),
    listPromotionCatalogue(session.businessId),
    listMessageTemplates(session.businessId),
    getPublicMessageConfig(),
    listCommissionRules(session.businessId, undefined, true),
  ]);

  const campaignCounts: Record<CampaignState, number> = {
    live: 0,
    scheduled: 0,
    paused: 0,
    ended: 0,
  };
  for (const promotion of promotions) {
    campaignCounts[classifyCampaign(promotion, today)] += 1;
  }

  const defaultProgram = programs.find((program) => program.isDefault && program.isActive) ?? null;
  const activeRules = commissionRules.filter((rule) => rule.isActive);

  return NextResponse.json({
    settings: {
      loyalty: {
        programCount: programs.length,
        activeProgramCount: programs.filter((program) => program.isActive).length,
        defaultProgram: defaultProgram
          ? {
              name: defaultProgram.name,
              earnPointsPer100000: defaultProgram.earnPointsPer100000,
              pointValueRial: defaultProgram.pointValueRial,
              pointsExpiryDays: defaultProgram.pointsExpiryDays,
            }
          : null,
      },
      campaigns: {
        total: promotions.length,
        ...campaignCounts,
      },
      messaging: {
        templateCount: templates.length,
        smsTemplateCount: templates.filter((template) => template.channel === "sms").length,
        emailTemplateCount: templates.filter((template) => template.channel === "email").length,
        enabled: messaging.enabled,
        configured: messaging.configured,
      },
      commission: {
        ruleCount: commissionRules.length,
        activeRuleCount: activeRules.length,
        staffWithActiveRules: new Set(activeRules.map((rule) => rule.employeeId)).size,
      },
    },
  });
});
