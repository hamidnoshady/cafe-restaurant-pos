import { pluginRoute } from "@/lib/integrations/plugin-route";
import { pluginPullJobs } from "@/lib/integrations/plugin-service";

/**
 * POS -> WordPress. Leases the next batch of outbox work for the plugin to
 * apply: stock levels, prices, and requests for a full catalogue or customer
 * export.
 *
 * POST rather than GET despite being a read: the request is signed over its
 * body, and a uniform envelope across every call in this channel is worth more
 * than method purity for an endpoint no browser or cache will ever see. It is
 * not idempotent anyway — leasing mutates.
 */
export const POST = pluginRoute(async (connection) => pluginPullJobs(connection));
