import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: {
    categoryId?: string;
    name?: string;
    price?: number;
    description?: string;
    sku?: string;
    imageUrl?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { categoryId, description, sku, imageUrl } = body;
  const name = body.name?.trim();
  const price = Number(body.price);
  if (!categoryId || !name || !Number.isSafeInteger(price) || price < 0) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (name.length > 200) return NextResponse.json({ error: "item_name_too_long" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: cat } = await query(
    "SELECT id FROM menu_categories WHERE id = $1 AND location_id = $2",
    [categoryId, location.id],
  );
  if (cat.length === 0) return NextResponse.json({ error: "category_not_found" }, { status: 404 });

  const { rows } = await query<{ id: string }>(
    `INSERT INTO menu_items (location_id, category_id, name, price, description, sku, image_url, sort_order)
     SELECT $1, $2, $3, $4, $5, $6, $7, COALESCE(MAX(sort_order) + 1, 0)
       FROM menu_items WHERE location_id = $1 AND category_id = $2
     RETURNING id`,
    [location.id, categoryId, name, price, description?.trim() || null, sku?.trim() || null, imageUrl?.trim() || null],
  );
  return NextResponse.json({ ok: true, id: rows[0].id });
});
