import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { getPrimaryLocation, type TaxSetting } from "@/lib/setup-state";

/** Create a menu category. Ongoing management, independent of the setup wizard. */
export async function POST(request: NextRequest) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { name?: string; taxRate?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: dup } = await query(
    "SELECT id FROM menu_categories WHERE location_id = $1 AND name = $2",
    [location.id, name],
  );
  if (dup.length > 0) return NextResponse.json({ error: "category_exists" }, { status: 409 });

  let taxRate = Number(body.taxRate);
  if (!Number.isFinite(taxRate)) {
    const tax = await getSetting<TaxSetting>(session.businessId, SETTING_KEYS.tax);
    taxRate = tax?.defaultRate ?? 0;
  }
  if (taxRate < 0 || taxRate > 100) {
    return NextResponse.json({ error: "invalid_rate" }, { status: 400 });
  }

  const { rows } = await query<{ id: string }>(
    `INSERT INTO menu_categories (location_id, name, tax_rate, sort_order)
     SELECT $1, $2, $3, COALESCE(MAX(sort_order) + 1, 0)
       FROM menu_categories WHERE location_id = $1
     RETURNING id`,
    [location.id, name, taxRate],
  );
  return NextResponse.json({ ok: true, id: rows[0].id });
}
