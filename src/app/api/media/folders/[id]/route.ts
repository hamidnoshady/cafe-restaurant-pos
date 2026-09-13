import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";

/** Rename or delete one folder. Assets in a deleted folder fall back to the root (FK SET NULL). */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  let body: { name?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const { rows } = await query<{ id: string }>(
    `UPDATE media_folders SET name = $3 WHERE id = $1 AND business_id = $2 RETURNING id`,
    [id, session.businessId, name],
  ).catch(() => ({ rows: [] as { id: string }[] }));
  if (!rows[0]) {
    return NextResponse.json(
      { error: "rename_failed", message: "تغییر نام ممکن نشد؛ شاید نام تکراری باشد." },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true });
});

export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const { rows } = await query<{ id: string }>(
    `DELETE FROM media_folders WHERE id = $1 AND business_id = $2 RETURNING id`,
    [id, session.businessId],
  );
  if (!rows[0]) return NextResponse.json({ error: "folder_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
