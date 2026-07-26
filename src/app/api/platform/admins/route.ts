import { NextResponse } from "next/server";
import { requirePlatformCapability } from "@/lib/platform-auth";
import { listPlatformAdmins } from "@/lib/platform-service";

/**
 * The roster of platform admins. Owner-only (`admins.manage`): who operates the
 * console — and at what role — is itself sensitive, so it is not a general read
 * surface the way businesses or audit are.
 */
export async function GET() {
  const { error } = await requirePlatformCapability("admins.manage");
  if (error) return error;
  return NextResponse.json({ admins: await listPlatformAdmins() });
}
