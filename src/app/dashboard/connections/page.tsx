import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { query, withTenant } from "@/lib/db";
import { effectiveFeatures } from "@/lib/features";
import type { Industry } from "@/lib/industries";
import { visibleConnectionKinds, resolveConnectionKind } from "@/lib/connection-kinds";
import { PageHeader, PageShell } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
import { ConnectionsManager } from "./connections-manager";

/**
 * Technical connections this business uses: the desktop install, Holoo and
 * developer/assistant access. WooCommerce is intentionally not rendered here;
 * the WP Manager owns the complete WordPress/WooCommerce system.
 *
 * Deliberately not gated as a whole. The technical tabs have different
 * entitlements — and desktop pairing is not an entitlement at all — so gating
 * the page would hide the free thing behind the paid ones. Each tab carries
 * its own lock instead.
 */
export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { tab } = await searchParams;
  // WooCommerce used to live in this generic hub. Keep old bookmarks working,
  // but do not render the store manager here: the WP app owns that system now.
  if (tab === "woocommerce") redirect("/dashboard/wp/connections");

  const [features, { rows }] = await withTenant(session.businessId, () =>
    Promise.all([
      effectiveFeatures(session.businessId),
      query<{ industry: Industry }>("SELECT industry FROM businesses WHERE id = $1", [session.businessId]),
    ]),
  );
  const industry = rows[0]?.industry ?? "food_service";

  const kinds = visibleConnectionKinds({ role: session.role, industry });
  // A role with nothing to connect (a cashier, a waiter) has no page here at
  // all rather than an empty one.
  if (kinds.length === 0) redirect("/dashboard");

  const active = resolveConnectionKind(tab, kinds)!;

  return (
    <PageShell>
      <PageHeader
        title="اتصال‌ها"
        description="اتصال این کسب‌وکار به برنامهٔ دسکتاپ، هلو و برنامه‌های توسعه‌دهندگان — همراه با آزمایش اتصال و مدیریت کلیدها."
        actions={<KnowledgeHelpButton section="connections" />}
      />
      <ConnectionsManager
        kinds={kinds}
        initialTab={active}
        // A «?tab=» link named a section, so a phone opens that section rather
        // than the list it sits in — the link is the whole point of the param.
        initialOpen={Boolean(tab)}
        features={{
          integrations: Boolean(features.integrations),
          api_platform: Boolean(features.api_platform),
        }}
      />
    </PageShell>
  );
}
