/**
 * What «مدیریت وب‌سایت» knows about a business's two website systems.
 *
 * One read, answering the question the app is organised around: which of the
 * two managers does this business actually have? The sidebar builds its menu
 * from it, the app home draws its two cards from it, and both do so from
 * *observed* state — a live CMS connection row and the WooCommerce/WordPress
 * connections — never from a flag somebody set or the absence of an error.
 *
 * Deliberately cheap: two local queries and no call to either external system.
 * A down CMS must not make the app's own menu slow or empty, which is the same
 * rule `src/lib/cms/client.ts` states for reads.
 */
import { query } from "../db";
import { cmsWebsiteState } from "../cms/website-service";
import { getWebsiteSetup } from "./setup-service";
import type { WebsiteSetupState } from "./setup";

export interface WebsiteManagersState {
  cms: {
    connected: boolean;
    domain: string | null;
    setupStep: WebsiteSetupState["stage"] | null;
  };
  wp: {
    connected: boolean;
    storeCount: number;
  };
}

export async function websiteManagersState(businessId: string): Promise<WebsiteManagersState> {
  const [connection, setup, stores] = await Promise.all([
    cmsWebsiteState(businessId),
    getWebsiteSetup(businessId),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM integration_connections
        WHERE business_id = $1 AND provider = 'woocommerce'`,
      [businessId],
    ),
  ]);

  const storeCount = Number(stores.rows[0]?.count ?? 0);
  return {
    cms: {
      connected: Boolean(connection),
      domain: connection?.siteDomain ?? setup.domain,
      // A business that has never opened the wizard has no step at all; one
      // that has, but has no site yet, shows where it got to.
      setupStep: connection ? "built" : setup.domain || setup.stage !== "domain" ? setup.stage : null,
    },
    wp: { connected: storeCount > 0, storeCount },
  };
}
