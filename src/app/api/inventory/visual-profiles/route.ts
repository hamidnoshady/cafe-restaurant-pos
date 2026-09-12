import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  MAX_PROFILES_PER_ITEM,
  parseVisualProfilePayload,
  type VisualProfileRecord,
} from "@/lib/inventory-visual-profiles";

/**
 * The «برچسب تصویری» store: reference photos of one unit of an item, the
 * features the pure counting engine (src/lib/vision/) matches future photos
 * against, and who did the tagging ('manual' vs 'ai').
 *
 * The heavy validation lives in the pure module; these routes do the I/O and
 * the tenancy scoping — an item must belong to the caller's active branch,
 * which RLS also enforces on the business_id column.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const itemId = new URL(request.url).searchParams.get("itemId");
  if (!itemId) return NextResponse.json({ profiles: [] });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ profiles: [] });

  const { rows } = await query<VisualProfileRecord>(
    `SELECT p.id, p.inventory_item_id AS "inventoryItemId", p.source, p.kind,
            p.image_data_url AS "imageDataUrl", p.region, p.features,
            p.created_at AS "createdAt"
       FROM inventory_item_visual_profiles p
       JOIN inventory_items i ON i.id = p.inventory_item_id
      WHERE p.inventory_item_id = $1 AND i.location_id = $2
      ORDER BY p.created_at DESC`,
    [itemId, location.id],
  );
  return NextResponse.json({ profiles: rows });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const payload = parseVisualProfilePayload(body);
  if (!payload) return NextResponse.json({ error: "invalid_profile" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: items } = await query<{ id: string }>(
    "SELECT id FROM inventory_items WHERE id = $1 AND location_id = $2",
    [payload.inventoryItemId, location.id],
  );
  if (items.length === 0) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  const { rows: existing } = await query<{ count: string }>(
    "SELECT count(*) AS count FROM inventory_item_visual_profiles WHERE inventory_item_id = $1",
    [payload.inventoryItemId],
  );
  if (Number(existing[0].count) >= MAX_PROFILES_PER_ITEM) {
    return NextResponse.json({ error: "profile_limit_reached" }, { status: 409 });
  }

  const { rows } = await query<VisualProfileRecord>(
    `INSERT INTO inventory_item_visual_profiles
        (business_id, inventory_item_id, source, kind, image_data_url, region, features, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, inventory_item_id AS "inventoryItemId", source, kind,
               image_data_url AS "imageDataUrl", region, features,
               created_at AS "createdAt"`,
    [
      session.businessId,
      payload.inventoryItemId,
      payload.source,
      payload.kind,
      payload.imageDataUrl,
      JSON.stringify(payload.region),
      JSON.stringify(payload.features),
      session.sub,
    ],
  );
  return NextResponse.json({ profile: rows[0] }, { status: 201 });
});
