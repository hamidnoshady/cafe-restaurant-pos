import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listMessageCampaignRoiReport } from "@/lib/message-campaigns-service";

/**
 * Campaign ROI is deliberately available only for a campaign with its own
 * promotion. We never infer attribution from an audience, a message body, or
 * an eventual customer purchase.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;
  const rows = await listMessageCampaignRoiReport(session.businessId);
  return NextResponse.json({ rows });
});
