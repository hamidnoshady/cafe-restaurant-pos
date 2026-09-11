import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { listMessageCampaignRoiReport } from "@/lib/message-campaigns-service";

/**
 * Campaign ROI is deliberately available only for a campaign with its own
 * promotion. We never infer attribution from an audience, a message body, or
 * an eventual customer purchase.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;
  const rows = await listMessageCampaignRoiReport(session.businessId);
  return NextResponse.json({ rows });
});
