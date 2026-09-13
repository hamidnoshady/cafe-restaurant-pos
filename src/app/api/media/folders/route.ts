import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { MAX_FOLDER_DEPTH } from "@/lib/media";
import { listMediaFolders } from "@/lib/media-service";

/** The library's visual folder tree: list and create. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  return NextResponse.json({ folders: await listMediaFolders(session.businessId) });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { name?: unknown; parentId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  let parentId: string | null = null;
  if (body.parentId !== undefined && body.parentId !== null && body.parentId !== "") {
    if (typeof body.parentId !== "string") return NextResponse.json({ error: "bad_request" }, { status: 400 });
    // The parent must be this business's own, and the tree must stay shallow
    // enough to render as a path («تصاویر منو / نوشیدنی‌ها / گرم»).
    let depth = 0;
    let cursor: string | null = body.parentId;
    while (cursor && depth <= MAX_FOLDER_DEPTH) {
      const { rows }: { rows: { id: string; parent_id: string | null }[] } = await query<{ id: string; parent_id: string | null }>(
        `SELECT id, parent_id FROM media_folders WHERE id = $1 AND business_id = $2`,
        [cursor, session.businessId],
      );
      if (!rows[0]) return NextResponse.json({ error: "folder_not_found" }, { status: 404 });
      cursor = rows[0].parent_id;
      depth += 1;
    }
    if (depth >= MAX_FOLDER_DEPTH) {
      return NextResponse.json(
        { error: "too_deep", message: "عمق پوشه‌ها بیش از حد مجاز است." },
        { status: 400 },
      );
    }
    parentId = body.parentId;
  }

  const { rows } = await query<{ id: string }>(
    `INSERT INTO media_folders (business_id, parent_id, name, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [session.businessId, parentId, name, session.sub],
  );
  if (!rows[0]) {
    return NextResponse.json(
      { error: "duplicate_name", message: "پوشه‌ای با همین نام در این محل وجود دارد." },
      { status: 409 },
    );
  }
  return NextResponse.json({ id: rows[0].id }, { status: 201 });
});
