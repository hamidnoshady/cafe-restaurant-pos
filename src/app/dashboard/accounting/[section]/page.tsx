import { redirect } from "next/navigation";
import { AccountingPageBody } from "../accounting-page-body";
import {
  ACCOUNTING_HOME,
  isAccountingSectionKey,
} from "../accounting-routes";

/**
 * One page per Accounting section, one file — every section renders the same
 * app chrome (`accounting-page-body.tsx`), so there is nothing
 * section-specific about the page itself beyond the key it hands down. The
 * per-section role line (payroll) is drawn by the body, from
 * `canViewAccountingSection`.
 *
 * An unknown section lands on the app's home rather than a 404, and
 * `/dashboard/accounting/dashboard` — the one section whose route *is* the
 * app root — forwards there too, so the home has exactly one address.
 */
export default async function AccountingSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!isAccountingSectionKey(section) || section === "dashboard") redirect(ACCOUNTING_HOME);
  return <AccountingPageBody section={section} />;
}
