import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { featureLockedForPage } from "@/lib/features";
import { FeatureLock } from "@/components/feature-lock";
import { WpAppShell } from "./wp-app-shell";

/**
 * The WordPress & WooCommerce Manager app's layout.
 *
 * Owner/manager only, matching the integrations surface it supersedes: every
 * page here writes to a live shopfront or sees the whole customer book. The
 * `integrations` entitlement is applied once at this app boundary as a locked
 * preview, rather than making the standalone app disappear. The sidebar slot
 * is owned by src/lib/app-shells.ts (which hands it to wp-app-nav.tsx); this
 * layout only gates and frames.
 */
export default async function WpManagerLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  // `integrations` is lockable: WP Manager remains visible as a standalone app,
  // but all store reads/writes become an inert product preview until the
  // business is entitled. The child panels also skip API calls in this context.
  const locked = await featureLockedForPage(session.businessId, "integrations");

  return (
    <FeatureLock locked={locked} title="مدیریت وردپرس و ووکامرس">
      <WpAppShell>{children}</WpAppShell>
    </FeatureLock>
  );
}
