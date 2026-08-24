import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { revokeMcpOauthToken } from "@/lib/mcp/oauth-service";
import { resolveMcpTenant } from "@/lib/mcp/origin";

/**
 * RFC 7009 — token revocation, so a client that is being removed can hand its
 * token back rather than leaving a live credential behind.
 *
 * Always answers 200, even for a token that never existed. That is what the RFC
 * requires and it is also the only safe behaviour: this endpoint is
 * unauthenticated, so a truthful "no such token" would turn it into an oracle
 * for testing guessed credentials.
 *
 * This revokes *one token*, not the connection. Removing the connector itself is
 * an owner's action on the connections screen, which revokes the connection row
 * and deletes every token with it.
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

export async function POST(request: NextRequest) {
  const tenant = await resolveMcpTenant(request.headers);
  const ok = new NextResponse(null, { status: 200 });
  ok.headers.set("Access-Control-Allow-Origin", "*");
  ok.headers.set("Cache-Control", "no-store");
  if (!tenant.ok) return ok;

  let token = "";
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await request.json()) as { token?: unknown };
      token = typeof body.token === "string" ? body.token : "";
    } catch {
      token = "";
    }
  } else {
    const form = await request.formData();
    const value = form.get("token");
    token = typeof value === "string" ? value : "";
  }

  if (token) {
    const businessId = tenant.business.businessId;
    await withTenant(businessId, () => revokeMcpOauthToken(businessId, token));
  }
  return ok;
}
