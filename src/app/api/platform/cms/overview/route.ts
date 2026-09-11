import { NextRequest, NextResponse } from "next/server";

import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { fetchCmsOverview } from "@/lib/cms/platform-client";
import { cmsFleetFindings, mirrorIsStale } from "@/lib/cms/platform-control";
import {
  getCmsControlConfig,
  listCmsSyncRuns,
  listMirroredCmsSites,
  resolvePlatformCmsConfig,
} from "@/lib/cms/platform-control-service";
import { cmsErrorCode } from "@/lib/cms/platform-sync";

/**
 * «سایت‌ساز ← میز فرمان» — the whole website platform in one answer.
 *
 * Read-only and gated on nothing but a platform-admin session: how many sites are
 * unverified is not privileged information, and an operator who cannot look is an
 * operator who escalates instead.
 *
 * Two sources, deliberately:
 *
 *  - the **live report** from the CMS (`GET /api/platform/overview` over there),
 *    which is the truth and may be unavailable;
 *  - the **mirror** (`platform_cms_sites`, migration 0139), which always answers
 *    and is stamped with when it was read.
 *
 * The response carries both, plus `mirrorStale`, so the page can show real figures
 * with an honest caveat rather than an empty screen. A read from the CMS is
 * best-effort by design (see `src/lib/cms/client.ts`): a down CMS must never take
 * the console with it, and `overviewError` is how the page says which half is
 * missing.
 */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformAdmin();
  if (error) return error;

  const config = await getCmsControlConfig();
  const sites = await listMirroredCmsSites();
  const runs = await listCmsSyncRuns(10);

  const days = Number(request.nextUrl.searchParams.get("days"));
  const client = await resolvePlatformCmsConfig();

  let overview = null;
  let overviewError: null | string = null;
  if (client) {
    try {
      overview = await fetchCmsOverview(
        client,
        { days: Number.isFinite(days) ? days : undefined },
        { actor: session.padmin },
      );
    } catch (err) {
      overviewError = cmsErrorCode(err);
    }
  } else {
    overviewError = "cms_not_configured";
  }

  return NextResponse.json({
    config,
    findings: cmsFleetFindings(sites),
    mirrorStale: mirrorIsStale(config.lastMirrorAt, config.mirrorIntervalMinutes),
    mirroredAt: config.lastMirrorAt,
    overview,
    overviewError,
    runs,
    sites,
  });
});
