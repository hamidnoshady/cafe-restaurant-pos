import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createItem, createVariantChild, updateItemMeta, type ItemMetaPatch } from "@/lib/items-service";
import { receiveStock, setUnitPrice } from "@/lib/accessories-service";
import { validateVariantAttributes, type VariantAttributeInput } from "@/lib/items";

interface VariantInput {
  name?: string;
  sku?: string | null;
  attributes?: VariantAttributeInput[];
}

interface CreateProductBody extends ItemMetaPatch {
  variants?: VariantInput[];
  /** Opening stock/price for a simple product, or for every variant row. */
  quantity?: number;
  sellPrice?: number | null;
  purchasePrice?: number | null;
}

/**
 * The add-product form's write path: one product (a `simple` item, or a
 * `variant_parent` plus its variant rows) with its Phase 42 meta columns and
 * optional opening stock/price. The trade's own items routes keep serving
 * the older surfaces; this is the workspace's door. Validation runs before
 * any write so a bad form never leaves a half-saved product behind.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  let body: CreateProductBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const variants = (body.variants ?? []).filter((v) => v && (v.name?.trim() || (v.attributes ?? []).some((a) => a.value?.trim())));
  for (const variant of variants) {
    const attributeErrors = validateVariantAttributes(variant.attributes ?? []);
    if (attributeErrors.length > 0) {
      return NextResponse.json({ error: "invalid_attributes", message: attributeErrors.join("؛ ") }, { status: 400 });
    }
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  try {
    const parent = await createItem({
      locationId: location.id,
      name,
      sku: body.sku?.trim() || null,
      kind: variants.length > 0 ? "variant_parent" : "simple",
    });

    const meta: ItemMetaPatch = { ...body };
    delete meta.name;
    await updateItemMeta(parent.id, meta);

    const priced: string[] = variants.length > 0 ? [] : [parent.id];
    if (variants.length > 0) {
      for (const variant of variants) {
        const attributes = (variant.attributes ?? []).filter((a) => a.name?.trim() && a.value?.trim());
        const child = await createVariantChild(
          parent.id,
          location.id,
          variant.name?.trim() || [name, ...attributes.map((a) => a.value)].join(" — "),
          variant.sku?.trim() || null,
          attributes,
        );
        priced.push(child.id);
      }
    }

    for (const itemId of priced) {
      if (body.sellPrice != null && body.sellPrice > 0) await setUnitPrice(itemId, body.sellPrice);
      if (body.purchasePrice != null || (body.quantity ?? 0) > 0) {
        await receiveStock(itemId, {
          quantity: String(body.quantity ?? 0),
          unitCost: Number(body.purchasePrice ?? 0),
        });
      }
    }

    return NextResponse.json({ ok: true, item: parent });
  } catch (err) {
    if (err instanceof Error && /duplicate/i.test(err.message)) {
      return NextResponse.json({ error: "duplicate_item" }, { status: 409 });
    }
    throw err;
  }
});
