import { NextRequest, NextResponse } from "next/server";
import { authorizationServerMetadata } from "@/lib/mcp/oauth";
import { mcpIssuer } from "@/lib/mcp/origin";

/**
 * RFC 8414 — authorization server metadata, served at
 * `/.well-known/oauth-authorization-server` (rewritten there in
 * `next.config.ts`).
 *
 * Same optional catch-all as the protected-resource document next door, for the
 * same reason: clients differ on whether they append the resource path, and a
 * 404 reads as "no OAuth here".
 *
 * The one field that makes the whole connector work by pasting a URL is
 * `registration_endpoint`. Without dynamic client registration every business
 * would have to pre-register Claude, ChatGPT and every other client by hand
 * before an owner could connect any of them.
 */
export async function GET(request: NextRequest) {
  const issuer = mcpIssuer(request.headers, request.nextUrl.protocol);
  const response = NextResponse.json(authorizationServerMetadata(issuer));
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Cache-Control", "public, max-age=3600");
  return response;
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
    },
  });
}
