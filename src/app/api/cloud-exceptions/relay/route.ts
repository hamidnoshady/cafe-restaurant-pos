import { NextRequest, NextResponse } from "next/server";
import { acceptCloudExceptionBatch, authenticateCloudExceptionInstallation, CLOUD_EXCEPTION_KINDS, type CloudExceptionKind } from "@/lib/cloud-exception-relay";
import { deploymentRole } from "@/lib/deployment-role";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  if (deploymentRole() !== "central") return NextResponse.json({ error: "not_found" }, { status: 404 });
  let body: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 10 * 1024 * 1024) return NextResponse.json({ error: "batch_too_large" }, { status: 413 });
    body = JSON.parse(raw);
  } catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  const input = body as { installationId?: unknown; events?: unknown };
  if (typeof input.installationId !== "string" || input.installationId.length < 8 || input.installationId.length > 200 || !Array.isArray(input.events) || input.events.length < 1 || input.events.length > 2) {
    return NextResponse.json({ error: "invalid_batch" }, { status: 400 });
  }
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token || !(await authenticateCloudExceptionInstallation(input.installationId, token))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const events: Parameters<typeof acceptCloudExceptionBatch>[0]["events"] = [];
  for (const raw of input.events) {
    const event = raw as Record<string, unknown>;
    if (!UUID.test(String(event.eventId ?? "")) || !UUID.test(String(event.aggregateId ?? "")) ||
        typeof event.kind !== "string" || !(CLOUD_EXCEPTION_KINDS as readonly string[]).includes(event.kind) ||
        typeof event.occurredAt !== "string" || !Number.isFinite(Date.parse(event.occurredAt)) ||
        typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
      return NextResponse.json({ error: "invalid_event" }, { status: 400 });
    }
    events.push({ eventId: event.eventId as string, aggregateId: event.aggregateId as string,
      kind: event.kind as CloudExceptionKind, occurredAt: event.occurredAt, payload: event.payload as Record<string, unknown> });
  }
  await acceptCloudExceptionBatch({ installationId: input.installationId, events });
  return NextResponse.json({ accepted: events.length });
}
