import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { query } from "@/lib/db";
import { provisionCloudExceptionInstallation } from "@/lib/cloud-exception-relay";

/** Standalone-installation Support/Bug Report inbox; payload is never logged. */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("support.manage");
  if (error) return error;
  const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("limit")) || 50, 1), 200);
  const kind = request.nextUrl.searchParams.get("kind")?.trim() || null;
  const { rows } = await query<{
    id: string; installationId: string; installationLabel: string; eventId: string; kind: string;
    aggregateId: string; payload: Record<string, unknown>; occurredAt: string; receivedAt: string;
  }>(
    `SELECT i.id::text,i.installation_id AS "installationId",COALESCE(c.label,i.installation_id) AS "installationLabel",
            i.event_id::text AS "eventId",i.kind,i.aggregate_id::text AS "aggregateId",
            (i.payload - ARRAY['attachment','screenshot','userAgent']::text[]) AS payload,
            i.occurred_at::text AS "occurredAt",i.received_at::text AS "receivedAt"
       FROM cloud_exception_inbox i
       LEFT JOIN cloud_exception_installations c ON c.installation_id=i.installation_id
      WHERE ($2::text IS NULL OR i.kind=$2)
      ORDER BY i.received_at DESC LIMIT $1`,
    [limit, kind],
  );
  return NextResponse.json({ events: rows });
});

/** Issues one per-installation credential; the plaintext token is returned once. */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("support.manage");
  if (error) return error;
  let body: { label?: unknown };
  try { body = await request.json() as { label?: unknown }; }
  catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) return NextResponse.json({ error: "label_required" }, { status: 400 });
  return NextResponse.json(await provisionCloudExceptionInstallation(label), { status: 201 });
});
