import { redirect } from "next/navigation";
import { AccountingPageBody } from "../accounting-page-body";
import {
  ACCOUNTING_HOME,
  accountingSectionForLegacyKey,
  accountingSectionHref,
  isAccountingSectionKey,
} from "../accounting-routes";

/**
 * One page per Accounting section, one file — every section renders the same
 * app chrome (`accounting-page-body.tsx`), so there is nothing
 * section-specific about the page itself beyond the key it hands down. The
 * per-section role line (payroll) is drawn by the body, from
 * `canViewAccountingSection`.
 *
 * Three things this route deliberately does *not* do:
 *  - it does not answer `overview`; that is a real static route beside this
 *    one, which is what keeps the app's home from being a dynamic match;
 *  - it does not 404 an old section name — `ar`, `ap` and `parties` redirect
 *    to the sections they became;
 *  - it does not append the home segment to anything, so no section can ever
 *    forward to `…/overview/overview`.
 */
export default async function AccountingSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  const alias = accountingSectionForLegacyKey(section);
  if (alias) redirect(accountingSectionHref(alias));
  if (!isAccountingSectionKey(section) || section === "dashboard") redirect(ACCOUNTING_HOME);
  return <AccountingPageBody section={section} />;
}
