import { redirect } from "next/navigation";

/**
 * Retired route (migration 0176): the standalone Plan Builder moved into the
 * Billing Control Center. This permanent redirect keeps every bookmark,
 * nav link and doc reference working — `/platform/plans` → the plans tab.
 */
export default function PlatformPlansRedirectPage() {
  redirect("/platform/billing?tab=plans");
}
