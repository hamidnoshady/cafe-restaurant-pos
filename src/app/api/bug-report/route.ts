import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { enqueueCloudException } from "@/lib/cloud-exception-relay";

/**
 * In-app bug reports (see migrations/0127_bug_reports.sql).
 *
 * Any signed-in member of a business may file a report — reporting a problem is
 * not a privileged act, so `requireMember` (not `requireRole`) is the right
 * gate. The handler scopes the INSERT to the session's business via the ambient
 * tenant scope established by `withTenantScope`; RLS enforces it at the
 * database level, so `business_id` is taken from the session, never the body.
 *
 * A screenshot is an optional downscaled JPEG data URL (a few hundred KB at
 * most). `description` is required, but may be short.
 */

const MAX_DESCRIPTION = 5000;
const MAX_SCREENSHOT = 4 * 1024 * 1024; // 4 MiB, generous for a downscaled JPEG

interface BugReportBody {
  description?: unknown;
  screenshot?: unknown;
  pageUrl?: unknown;
  userAgent?: unknown;
  viewport?: unknown;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireMember();
  if (error) return error;

  let body: BugReportBody;
  try {
    body = (await request.json()) as BugReportBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description) {
    return NextResponse.json({ error: "description_required" }, { status: 400 });
  }
  if (description.length > MAX_DESCRIPTION) {
    return NextResponse.json({ error: "description_too_long" }, { status: 400 });
  }

  const screenshot = typeof body.screenshot === "string" ? body.screenshot : null;
  if (screenshot && screenshot.length > MAX_SCREENSHOT) {
    return NextResponse.json({ error: "screenshot_too_large" }, { status: 400 });
  }
  // Defensive: only accept image data URLs.
  if (screenshot && !screenshot.startsWith("data:image/")) {
    return NextResponse.json({ error: "screenshot_invalid" }, { status: 400 });
  }

  const pageUrl = typeof body.pageUrl === "string" ? body.pageUrl.slice(0, 2000) : null;
  const userAgent = typeof body.userAgent === "string" ? body.userAgent.slice(0, 1000) : null;
  const viewport = typeof body.viewport === "string" ? body.viewport.slice(0, 200) : null;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO bug_reports (business_id, location_id, user_id, description, screenshot, page_url, user_agent, viewport)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [session.businessId, session.locationId ?? null, session.sub, description,
        screenshot, pageUrl, userAgent, viewport],
    );
    await enqueueCloudException(client, {
      businessId: session.businessId,
      kind: "bug_report.created",
      aggregateId: rows[0].id,
      payload: { reportId: rows[0].id, locationId: session.locationId ?? null,
        userId: session.sub, description, screenshot, pageUrl, userAgent, viewport },
    });
    await client.query("COMMIT");
    return NextResponse.json({ id: rows[0].id }, { status: 201 });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});
