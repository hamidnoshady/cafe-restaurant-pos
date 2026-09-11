import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { quickUpdatePrices, type QuickUpdateTarget } from "@/lib/price-lists-service";

/** «بروزرسانی سریع»: one percent/amount move over a whole price column. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  let body: {
    target?: QuickUpdateTarget;
    mode?: "percent" | "amount";
    value?: number;
    round?: boolean;
    itemIds?: string[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const target = body.target;
  if (!target || (target.kind !== "sale" && target.kind !== "purchase" && target.kind !== "list")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.mode !== "percent" && body.mode !== "amount") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const value = Number(body.value);
  if (!Number.isFinite(value)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const changed = await quickUpdatePrices({
    target,
    mode: body.mode,
    value,
    round: Boolean(body.round),
    itemIds: Array.isArray(body.itemIds) ? body.itemIds : [],
    locationId: location.id,
  });
  return NextResponse.json({ ok: true, changed });
});
