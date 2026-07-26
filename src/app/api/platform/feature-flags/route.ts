import { NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { listFeatureFlags } from "@/lib/platform-service";

/** The global flag catalogue — the definitions the console offers to override per business. */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  return NextResponse.json({ flags: await listFeatureFlags() });
});
