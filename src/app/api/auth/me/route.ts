import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

export async function GET() {
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
}
