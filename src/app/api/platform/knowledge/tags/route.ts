import { NextRequest, NextResponse } from "next/server";
import {
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
  platformAudit,
} from "@/lib/platform-auth";
import {
  adminCreateKbTag,
  adminListKbTags,
  knowledgeError,
  parseTagInput,
} from "@/lib/knowledge-service";

/**
 * The knowledge base's tags (migration 0131) — read any admin, write with
 * `knowledge.manage`. Tags are the cross-cutting labels («چاپ»، «آفلاین»…)
 * the member centre filters by, independent of the category tree.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  return NextResponse.json({ tags: await adminListKbTags() });
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("knowledge.manage");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = parseTagInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const id = await adminCreateKbTag(parsed.input, session.padmin);
    await platformAudit({
      adminId: session.padmin,
      action: "knowledge_tag.create",
      entity: "knowledge_tags",
      entityId: id,
      payload: { slug: parsed.input.slug, label: parsed.input.label },
    });
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return knowledgeError(err);
  }
});
