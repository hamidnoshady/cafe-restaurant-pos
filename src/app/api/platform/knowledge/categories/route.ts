import { NextRequest, NextResponse } from "next/server";
import {
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
  platformAudit,
} from "@/lib/platform-auth";
import {
  adminCreateKbCategory,
  adminListKbCategories,
  knowledgeError,
  parseCategoryInput,
} from "@/lib/knowledge-service";

/**
 * The console's category builder (migration 0131) — read half. Every console
 * admin may list categories (they are labels and structure, no tenant data);
 * writes need `knowledge.manage`. The tree itself is nested client-side with
 * buildKbCategoryTree, the same function the member side menu uses.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  return NextResponse.json({ categories: await adminListKbCategories() });
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
  const parsed = parseCategoryInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const id = await adminCreateKbCategory(parsed.input, session.padmin);
    await platformAudit({
      adminId: session.padmin,
      action: "knowledge_category.create",
      entity: "knowledge_categories",
      entityId: id,
      payload: { slug: parsed.input.slug, title: parsed.input.title },
    });
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return knowledgeError(err);
  }
});
