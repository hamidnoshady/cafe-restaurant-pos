import { NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";

export const GET = withTenantScope(async () => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    user: {
      id: session.sub,
      role: session.role,
      fullName: session.fullName,
      businessId: session.businessId,
      locationId: session.locationId,
    },
  });
});
