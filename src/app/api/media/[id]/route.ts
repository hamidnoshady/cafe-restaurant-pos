import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { parseCategory, parseTags } from "@/lib/media";
import { deleteMediaAsset, getMediaAsset, getMediaConfig } from "@/lib/media-service";

/**
 * One media asset: organize (PATCH) and delete (DELETE).
 *
 * PATCH moves the asset between folders, renames it, and sets its category
 * and tags — including the confirm/reject decision over an AI proposal:
 * `aiDecision: "confirm"` copies the pending `ai_labels` into the real
 * category/tags columns (merged with any edits in the same request), and
 * `"reject"` clears the proposal. Auto-tags never apply themselves.
 */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const asset = await getMediaAsset(session.businessId, id);
  if (!asset) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

  let body: {
    fileName?: unknown;
    folderId?: unknown;
    category?: unknown;
    tags?: unknown;
    aiDecision?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const fields: string[] = [];
  const values: unknown[] = [id, session.businessId];
  let i = 2;
  const set = (col: string, val: unknown) => {
    fields.push(`${col} = $${++i}`);
    values.push(val);
  };

  if (body.fileName !== undefined) {
    const name = typeof body.fileName === "string" ? body.fileName.trim().slice(0, 200) : "";
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    set("file_name", name);
  }

  if (body.folderId !== undefined) {
    if (body.folderId === null || body.folderId === "") {
      set("folder_id", null);
    } else if (typeof body.folderId === "string") {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM media_folders WHERE id = $1 AND business_id = $2`,
        [body.folderId, session.businessId],
      );
      if (!rows[0]) return NextResponse.json({ error: "folder_not_found" }, { status: 404 });
      set("folder_id", body.folderId);
    } else {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }

  // The AI proposal's fate. Confirm merges the proposal into the real
  // columns; explicit category/tags in the same body win over the proposal
  // (the operator edited before confirming).
  const decision = body.aiDecision;
  if (decision !== undefined && decision !== "confirm" && decision !== "reject") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  let category = parseCategory(body.category);
  if (category === undefined && body.category !== undefined) {
    return NextResponse.json({ error: "invalid_category" }, { status: 400 });
  }
  let tags = body.tags !== undefined ? parseTags(body.tags) : undefined;
  if (tags === null) return NextResponse.json({ error: "invalid_tags" }, { status: 400 });

  if (decision === "confirm") {
    const proposal = asset.aiLabels as { category?: unknown; tags?: unknown };
    if (body.category === undefined) {
      category = typeof proposal.category === "string" && proposal.category ? proposal.category : asset.category;
    }
    if (tags === undefined) {
      const proposed = Array.isArray(proposal.tags) ? proposal.tags.filter((t): t is string => typeof t === "string") : [];
      tags = [...new Set([...asset.tags, ...proposed])];
    }
    set("ai_status", "confirmed");
  } else if (decision === "reject") {
    set("ai_status", "rejected");
  }

  if (body.category !== undefined || decision === "confirm") set("category", category ?? null);
  if (tags !== undefined) set("tags", tags);

  if (fields.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  fields.push("updated_at = now()");

  await query(
    `UPDATE media_assets SET ${fields.join(", ")} WHERE id = $1 AND business_id = $2`,
    values,
  );
  const updated = await getMediaAsset(session.businessId, id);
  return NextResponse.json({ asset: updated });
});

export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  // An asset a catalogue item points at loses the pointer (FK SET NULL), so
  // deletion is safe; the item simply shows no photo afterwards.
  const config = await getMediaConfig();
  const deleted = await deleteMediaAsset(session.businessId, id, config);
  if (!deleted) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
