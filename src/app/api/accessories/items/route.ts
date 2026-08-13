import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createItem, createVariantChild, getItem } from "@/lib/items-service";
import { listVariantBoard } from "@/lib/accessories-service";
import { validateVariantAttributes, type VariantAttributeInput } from "@/lib/items";

/** The accessories board: every product family and its variants, with attributes, stock and pricing. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "accessories");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ items: [] });

  const items = await listVariantBoard(location.id);
  return NextResponse.json({ items });
});

/**
 * Creates either a product family (no parentItemId) or one variant of one
 * (parentItemId + its distinguishing attributes) — the same two shapes
 * Wave 1's `items` model already distinguishes.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "accessories");
  if (industryError) return industryError;

  let body: {
    name?: string;
    sku?: string | null;
    parentItemId?: string | null;
    attributes?: VariantAttributeInput[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  if (!body.parentItemId) {
    const item = await createItem({
      locationId: location.id,
      name,
      sku: body.sku?.trim() || null,
      kind: "variant_parent",
    });
    return NextResponse.json({ ok: true, item });
  }

  const parent = await getItem(body.parentItemId);
  if (!parent || parent.locationId !== location.id || parent.kind !== "variant_parent") {
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  }

  const attributes = body.attributes ?? [];
  const attributeErrors = validateVariantAttributes(attributes);
  if (attributeErrors.length > 0) {
    return NextResponse.json(
      { error: "invalid_attributes", message: attributeErrors.join("؛ ") },
      { status: 400 },
    );
  }

  const item = await createVariantChild(
    parent.id,
    location.id,
    name,
    body.sku?.trim() || null,
    attributes,
  );
  return NextResponse.json({ ok: true, item });
});
