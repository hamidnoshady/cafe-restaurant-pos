import { pluginRoute } from "@/lib/integrations/plugin-route";
import { pluginPushEvents } from "@/lib/integrations/plugin-service";
import type { PluginEventInput } from "@/lib/integrations/webhook-ingest-service";

/**
 * WordPress -> POS. Orders, refunds, products and customers as the plugin
 * observed them, in batches, each with its own idempotency key so a re-send
 * after a timeout costs nothing. The per-event results tell the plugin exactly
 * which ones to send again.
 */
export const POST = pluginRoute(async (connection, body) =>
  pluginPushEvents(connection, {
    events: Array.isArray(body.events) ? (body.events as PluginEventInput[]) : [],
  }),
);
