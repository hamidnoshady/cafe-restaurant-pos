import { NextResponse } from "next/server";
import { pluginRoute } from "@/lib/integrations/plugin-route";

/**
 * The plugin's «آزمایش اتصال» button, and its liveness beacon.
 *
 * Cheapest possible authenticated call: reaching this handler at all already
 * proves the address is right, the token is right, the clock is within the
 * skew window, and the signature verifies — which is every way this connection
 * can be misconfigured. Authenticating is also what records
 * `last_plugin_seen_at`, so the app-side connection test has something true to
 * report without ever dialling the store.
 */
export const POST = pluginRoute(async (connection) =>
  NextResponse.json({
    ok: true,
    connectionId: connection.id,
    name: connection.name,
    status: connection.status,
    serverTime: new Date().toISOString(),
  }),
);
