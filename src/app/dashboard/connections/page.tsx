import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { query, withTenant } from "@/lib/db";
import { effectiveFeatures } from "@/lib/features";
import type { Industry } from "@/lib/industries";
import { visibleConnectionKinds, resolveConnectionKind } from "@/lib/connection-kinds";
import { PageHeader, PageShell } from "../page-chrome";
import { ConnectionsManager } from "./connections-manager";

/**
 * Everything this business connects *to*, in one place: the desktop install,
 * the online store, and the API keys a developer builds against.
 *
 * Deliberately not gated as a whole. Its three tabs have three different
 * entitlements — and one of them, desktop pairing, is not an entitlement at
 * all — so gating the page would hide the free thing behind the paid ones.
 * Each tab carries its own lock instead.
 */
export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

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

  const { tab } = await searchParams;
  const active = resolveConnectionKind(tab, kinds)!;

  return (
    <PageShell>
      <PageHeader
        title="اتصال‌ها"
        description="اتصال این کسب‌وکار به برنامهٔ دسکتاپ، فروشگاه اینترنتی و برنامه‌های توسعه‌دهندگان — همراه با آزمایش اتصال، وضعیت همگام‌سازی و مدیریت کلیدها."
      />
      <ConnectionsManager
        kinds={kinds}
        initialTab={active}
        features={{
          integrations: Boolean(features.integrations),
          api_platform: Boolean(features.api_platform),
        }}
      />
    </PageShell>
  );
}
