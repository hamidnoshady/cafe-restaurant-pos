import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { isFeatureEnabled } from "@/lib/features";
import { connectWebsite, disconnectWebsite, getWebsiteConnection } from "@/lib/website/connection-service";
import { summarizeWebsiteQueue } from "@/lib/website/catalog-service";
import { WEBSITE_ADAPTER_KEYS } from "@/lib/website/adapter";

/**
 * Phase 38 (issue #379) — the website connection, as the Connections hub sees
 * it. Owner-only: the credential can create products and rewrite prices on a
 * public storefront. Gated by the `integrations` flag like the other paid
 * connections; the hub still renders the tab locked when it is off.
 *
 * GET returns the masked summary and the queue counts. The API key is never
 * in any response — `WebsiteConnectionSummary` has no field for it.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  const enabled = await isFeatureEnabled(session.businessId, "integrations");
  if (!enabled) return NextResponse.json({ enabled, connection: null, queue: null });

  const [connection, queue] = await Promise.all([
    getWebsiteConnection(session.businessId),
    summarizeWebsiteQueue(session.businessId),
  ]);
  const response = NextResponse.json({ enabled, connection, queue });
  response.headers.set("Cache-Control", "no-store");
  return response;
});

interface ConnectBody {
  adapterKey?: unknown;
  baseUrl?: unknown;
  siteDomain?: unknown;
  apiKey?: unknown;
  siteCurrency?: unknown;
  keyName?: unknown;
}

/** Test-then-save. A failed test stores nothing and returns the adapter's error code. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  if (!(await isFeatureEnabled(session.businessId, "integrations"))) {
    return NextResponse.json({ error: "feature_disabled" }, { status: 403 });
  }

  let body: ConnectBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const adapterKey = typeof body.adapterKey === "string" ? body.adapterKey : "payload";
  if (!(WEBSITE_ADAPTER_KEYS as readonly string[]).includes(adapterKey)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // The in-memory mock is a development seam: it stores no real credential
  // and talks to no site, so production never accepts it.
  if (adapterKey === "mock" && process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await connectWebsite(session.businessId, {
    adapterKey: adapterKey as "payload" | "mock",
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
    siteDomain: typeof body.siteDomain === "string" ? body.siteDomain : "",
    apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
    siteCurrency: body.siteCurrency === "IRR" ? "IRR" : "IRT",
    keyName: typeof body.keyName === "string" ? body.keyName : undefined,
  });

  if (!result.ok) {
    const status = result.error === "unreachable" ? 503 : result.error === "unauthorized" ? 403 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  const response = NextResponse.json({ connection: result.connection, siteName: result.siteName });
  response.headers.set("Cache-Control", "no-store");
  return response;
});

/** Remove this app's stored key. The site and its content stay. */
export const DELETE = withTenantScope(async () => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  await disconnectWebsite(session.businessId);
  return NextResponse.json({ connection: null });
});
