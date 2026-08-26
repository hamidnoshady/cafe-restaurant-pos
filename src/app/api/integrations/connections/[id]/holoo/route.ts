import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getConnection } from "@/lib/integrations/connections-service";
import { getHolooSettings, updateHolooSettings } from "@/lib/integrations/holoo/connection-service";
import type { HolooCurrencyUnit } from "@/lib/integrations/holoo/holoo-money";
import type { HolooWriteMode } from "@/lib/integrations/holoo/connection-service";
import { isHoloo } from "@/lib/integrations/provider-registry";

/** Safe (secret-free) Holoo settings for one connection. */
export const GET = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const connection = await getConnection(session.businessId, id);
  if (!connection || !isHoloo(connection)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const settings = await getHolooSettings(session.businessId, id);
  if (!settings) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ settings });
});

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const connection = await getConnection(session.businessId, id);
  if (!connection || !isHoloo(connection)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await updateHolooSettings(session.businessId, id, {
    host: typeof body.host === "string" ? body.host : undefined,
    port: typeof body.port === "number" ? body.port : undefined,
    database: typeof body.database === "string" ? body.database : undefined,
    webServiceBaseUrl: typeof body.webServiceBaseUrl === "string" || body.webServiceBaseUrl === null ? body.webServiceBaseUrl : undefined,
    sqlUser: typeof body.sqlUser === "string" ? body.sqlUser : undefined,
    sqlPassword: typeof body.sqlPassword === "string" ? body.sqlPassword : undefined,
    wsUser: typeof body.wsUser === "string" ? body.wsUser : undefined,
    wsPassword: typeof body.wsPassword === "string" ? body.wsPassword : undefined,
    currencyUnit: body.currencyUnit === "rial" || body.currencyUnit === "toman" ? (body.currencyUnit as HolooCurrencyUnit) : undefined,
    writeMode: body.writeMode === "none" || body.writeMode === "web_service" || body.writeMode === "direct_sql" ? (body.writeMode as HolooWriteMode) : undefined,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 400 });
  return NextResponse.json({ settings: result.settings });
});
