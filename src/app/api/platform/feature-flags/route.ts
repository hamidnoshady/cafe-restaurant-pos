import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/platform-auth";
import { listFeatureFlags } from "@/lib/platform-service";

/** The global flag catalogue — the definitions the console offers to override per business. */
export async function GET() {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  return NextResponse.json({ flags: await listFeatureFlags() });
}
