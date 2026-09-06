import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { upsertWebsiteProduct, websiteStatusFor } from "@/lib/website/content-service";

/**
 * `POST /api/cms/website/catalog` — `website.product.upsert`, confirmed by a
 * human. Price is integer Rial; the adapter converts to the site's unit.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { remoteId?: unknown; title?: unknown; sku?: unknown; summary?: unknown; priceRial?: unknown; stock?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await upsertWebsiteProduct(session.businessId, {
    remoteId: typeof body.remoteId === "string" ? body.remoteId : undefined,
    title: typeof body.title === "string" ? body.title : "",
    sku: typeof body.sku === "string" ? body.sku : undefined,
    summary: typeof body.summary === "string" ? body.summary : undefined,
    priceRial: typeof body.priceRial === "number" ? body.priceRial : Number.NaN,
    stock: typeof body.stock === "number" ? body.stock : undefined,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: websiteStatusFor(result.error) });
  return NextResponse.json({ product: result.data }, { status: 201 });
});
