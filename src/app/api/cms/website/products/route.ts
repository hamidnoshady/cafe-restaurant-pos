import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { createCmsProduct, type CmsProductInput } from "@/lib/cms/website-service";

/** `POST /api/cms/website/products` — create a product on the connected CMS site. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: Partial<CmsProductInput>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await createCmsProduct(session.businessId, {
    title: typeof body.title === "string" ? body.title : "",
    price: typeof body.price === "number" ? body.price : NaN,
    summary: typeof body.summary === "string" ? body.summary : undefined,
    image: typeof body.image === "string" ? body.image : undefined,
    sku: typeof body.sku === "string" ? body.sku : undefined,
    trackInventory: typeof body.trackInventory === "boolean" ? body.trackInventory : undefined,
    inventory: typeof body.inventory === "number" ? body.inventory : undefined,
    compareAtPrice: typeof body.compareAtPrice === "number" ? body.compareAtPrice : undefined,
  });

  if (!result.ok) {
    const status = result.error === "not_connected" ? 409 : result.error === "cms_unreachable" ? 503 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({ product: result.data }, { status: 201 });
});
