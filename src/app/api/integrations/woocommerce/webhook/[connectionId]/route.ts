import { NextRequest } from "next/server";
import { handleWooCommerceWebhook } from "@/lib/integrations/webhook-ingest-service";

/**
 * Public, session-less: the caller is WooCommerce's webhook delivery system,
 * authenticated by the HMAC-SHA256 signature in `X-WC-Webhook-Signature`
 * against the connection's webhook secret — not by a tenant session. See
 * middleware.ts's PUBLIC_PATHS and the woocommerce-webhook-auth bypass reason.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await context.params;
  const rawBody = await request.text();
  return handleWooCommerceWebhook(connectionId, rawBody, request.headers);
}
