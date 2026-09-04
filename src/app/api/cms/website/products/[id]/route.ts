import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { deleteCmsProduct, updateCmsProduct, type CmsProductInput } from "@/lib/cms/website-service";

function statusFor(error: string): number {
  if (error === "not_found") return 404;
  if (error === "forbidden") return 403;
  if (error === "not_connected") return 409;
  if (error === "cms_unreachable") return 503;
  return 400;
}

/** `PATCH /api/cms/website/products/[id]` — edit a product on the connected CMS site. */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const { id } = await ctx.params;

  let body: Partial<CmsProductInput>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await updateCmsProduct(session.businessId, id, {
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(typeof body.price === "number" ? { price: body.price } : {}),
    ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
    ...(typeof body.image === "string" ? { image: body.image } : {}),
    ...(typeof body.sku === "string" ? { sku: body.sku } : {}),
    ...(typeof body.trackInventory === "boolean" ? { trackInventory: body.trackInventory } : {}),
    ...(typeof body.inventory === "number" ? { inventory: body.inventory } : {}),
    ...(typeof body.compareAtPrice === "number" ? { compareAtPrice: body.compareAtPrice } : {}),
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return NextResponse.json({ product: result.data });
});

/** `DELETE /api/cms/website/products/[id]` — remove a product from the connected CMS site. */
export const DELETE = withTenantScope(async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const { id } = await ctx.params;
  const result = await deleteCmsProduct(session.businessId, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return NextResponse.json({ deleted: true });
});
