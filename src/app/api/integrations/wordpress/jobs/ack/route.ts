import { pluginRoute } from "@/lib/integrations/plugin-route";
import { pluginAckJobs, type PluginJobAck } from "@/lib/integrations/plugin-service";

/**
 * The plugin reports what it did with each leased job. A `done` closes the
 * outbox row; a `failed` records the reason and schedules a backoff retry,
 * dead-lettering after the attempt cap — the same retry state the REST drain
 * uses, so both modes surface failures in one place on the dashboard.
 *
 * A job never acked simply has its lease expire and comes back on the next
 * pull, which is what makes a plugin dying mid-run safe.
 */
export const POST = pluginRoute(async (connection, body) =>
  pluginAckJobs(connection, Array.isArray(body.results) ? (body.results as PluginJobAck[]) : []),
);
