import { NextRequest, NextResponse } from "next/server";

import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { listCmsSyncRuns } from "@/lib/cms/platform-control-service";

/**
 * The sync log — every mirror, event poll, pull and push, newest first.
 *
 * Readable by any platform admin: "when did we last push content to that site?" is
 * the question a support operator asks before escalating, and the rows carry no
 * content, only counts and outcomes.
 */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const limit = Number(request.nextUrl.searchParams.get("limit"));
  return NextResponse.json({ runs: await listCmsSyncRuns(Number.isFinite(limit) ? limit : 30) });
});
