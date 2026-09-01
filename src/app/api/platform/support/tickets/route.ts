import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  listAssignablePlatformAdmins,
  listSupportTickets,
  supportTicketStats,
} from "@/lib/platform-service";

/**
 * The super-admin support desk — every business's tickets, cross-tenant.
 *
 * Gated on `support.manage`, which every platform-admin role holds (the
 * `support` role's whole job is this desk). Reads are scoped through the
 * platform bypass exactly like bug reports.
 */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("support.manage");
  if (error) return error;

  const searchParams = request.nextUrl.searchParams;
  const rawLimit = Number(searchParams.get("limit"));
  const assignedToMe = searchParams.get("assignedToMe") === "true";

  const [tickets, stats, assignableAdmins] = await Promise.all([
    listSupportTickets({
      status: searchParams.get("status") ?? "",
      priority: searchParams.get("priority") ?? "",
      category: searchParams.get("category") ?? "",
      search: searchParams.get("q") ?? "",
      businessId: searchParams.get("businessId") ?? "",
      assignedToMe,
      adminId: assignedToMe ? session.padmin : "",
      limit: Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 200,
    }),
    supportTicketStats(),
    listAssignablePlatformAdmins(),
  ]);

  return NextResponse.json({ tickets, stats, assignableAdmins });
});
