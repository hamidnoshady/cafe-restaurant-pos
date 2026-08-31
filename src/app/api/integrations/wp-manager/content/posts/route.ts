import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getConnection, wooClientFor } from "@/lib/integrations/connections-service";
import { query } from "@/lib/db";
import { writeIntegrationAudit } from "@/lib/integrations/audit";

/**
 * Create or update a WordPress post/page.
 *
 * Plugin mode: a `post_upsert` outbox row the plugin applies on its next
 * pull — the app cannot reach WordPress there, and the job carries the same
 * retry/backoff/dead-letter trail as every other push. REST mode: the app
 * writes wp/v2 directly with the store's consumer keys and mirrors the
 * resulting object locally.
 *
 * The field list is closed: the same rule the product ops channel enforces,
 * because a raw object written to a live site is a typo away from a
 * site-wide mistake.
 */
const ALLOWED_FIELDS = ["id", "post_type", "title", "content", "excerpt", "slug", "status"] as const;
const ALLOWED_STATUS = ["publish", "draft", "pending", "private", "future"];

export const POST = withTenantScope(async (request: Request) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const connectionId = String(body.connectionId ?? "");
  const connection = await getConnection(session.businessId, connectionId);
  if (!connection) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const postType = body.post_type === "page" ? "page" : "post";
  const patch: Record<string, unknown> = {};
  for (const field of ALLOWED_FIELDS) {
    if (body[field] !== undefined) patch[field] = String(body[field]);
  }
  patch.post_type = postType;
  if (patch.status && !ALLOWED_STATUS.includes(String(patch.status))) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }
  if (patch.title === undefined && patch.content === undefined) {
    return NextResponse.json({ error: "empty_patch" }, { status: 400 });
  }

  if (connection.link_mode === "plugin") {
    const remoteId = patch.id ? String(patch.id) : `new-${Date.now()}`;
    await query(
      `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload)
       VALUES ($1, $2, 'post_upsert', $3, $4::jsonb)
       ON CONFLICT (connection_id, entity_type, remote_id)
       DO UPDATE SET payload = EXCLUDED.payload, status = 'pending', attempts = 0,
                     next_attempt_at = now(), last_error = NULL, leased_until = NULL, updated_at = now()`,
      [session.businessId, connectionId, remoteId, JSON.stringify(patch)],
    );
    await writeIntegrationAudit({
      businessId: session.businessId,
      connectionId,
      action: "content.post_upsert_queued",
      entityType: "post_upsert",
      remoteId,
    });
    return NextResponse.json({ ok: true, queued: true });
  }

  try {
    const client = wooClientFor(connection);
    const wpType = postType === "page" ? "pages" : "posts";
    const id = patch.id ? Number(patch.id) : undefined;
    const result = await client.wpUpsertPost(wpType, patch, id);
    await writeIntegrationAudit({
      businessId: session.businessId,
      connectionId,
      action: "content.post_saved",
      entityType: "post",
      remoteId: String((result as { id?: number }).id ?? id ?? ""),
    });
    return NextResponse.json({ ok: true, remoteId: (result as { id?: number }).id });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
});
