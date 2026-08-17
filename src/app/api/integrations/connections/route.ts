import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createConnection, listConnections, type LinkMode } from "@/lib/integrations/connections-service";
import type { WooCurrencyUnit } from "@/lib/integrations/woo-money";

export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const connections = await listConnections(session.businessId);
  return NextResponse.json({ connections });
});

interface CreateBody {
  name?: string;
  baseUrl?: string;
  /** "plugin" to connect through the WordPress plugin; anything else is the REST/consumer-key shape. */
  linkMode?: LinkMode;
  consumerKey?: string;
  consumerSecret?: string;
  currencyUnit?: WooCurrencyUnit;
  locationId?: string | null;
  syncOrders?: boolean;
  syncProducts?: boolean;
  syncCustomers?: boolean;
  pushStock?: boolean;
  pushPrices?: boolean;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: CreateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await createConnection(session.businessId, session.sub, {
    name: body.name ?? "",
    baseUrl: body.baseUrl ?? "",
    linkMode: body.linkMode === "plugin" ? "plugin" : "rest_api",
    consumerKey: body.consumerKey ?? "",
    consumerSecret: body.consumerSecret ?? "",
    currencyUnit: body.currencyUnit ?? "toman",
    locationId: body.locationId ?? location.id,
    syncOrders: body.syncOrders,
    syncProducts: body.syncProducts,
    syncCustomers: body.syncCustomers,
    pushStock: body.pushStock,
    pushPrices: body.pushPrices,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  // Both secrets exist only in this response — the webhook secret the store
  // signs its deliveries with (REST mode) and the link token the plugin
  // authenticates with. Never cached, never retrievable afterwards.
  const response = NextResponse.json(
    { connection: result.connection, webhookSecret: result.webhookSecret, linkToken: result.linkToken ?? null },
    { status: 201 },
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
});
