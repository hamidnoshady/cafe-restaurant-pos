import { redirect } from "next/navigation";
import { partyDirectoryHref } from "@/lib/party-directory";
import { AccountingPageBody } from "../accounting-page-body";
import {
  ACCOUNTING_HOME,
  accountingDirectoryViewForLegacySection,
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
 * Four things this route deliberately does *not* do:
 *  - it does not answer `overview`; that is a real static route beside this
 *    one, which is what keeps the app's home from being a dynamic match;
 *  - it does not 404 an old section name — `ar`, `ap` and `parties` redirect
 *    to the sections they became, and the three per-role party screens
 *    (`customers`, `suppliers`, `vendors`) redirect to the one directory with
 *    their view preselected;
 *  - it does not drop a query string on the way: a redirect that loses
 *    `?party=…` sends somebody who clicked one customer to a list of everyone;
 *  - it does not append the home segment to anything, so no section can ever
 *    forward to `…/overview/overview`.
 */
export default async function AccountingSectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { section } = await params;
  const search = await searchParams;

  // The per-role party screens became views of the one directory. This is a
  // real route-level redirect (never a middleware pathname rewrite), and it
  // carries every parameter the visitor arrived with — `?party=` above all,
  // since that is what a deep link from A/R, A/P or an AI answer holds.
  const view = accountingDirectoryViewForLegacySection(section);
  if (view) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(search)) {
      if (key === "view") continue;
      if (Array.isArray(value)) for (const entry of value) params.append(key, entry);
      else if (value !== undefined) params.set(key, value);
    }
    const base = partyDirectoryHref(view);
    const extra = params.toString();
    redirect(extra ? `${base}${base.includes("?") ? "&" : "?"}${extra}` : base);
  }

  const alias = accountingSectionForLegacyKey(section);
  if (alias) redirect(accountingSectionHref(alias));
  if (!isAccountingSectionKey(section) || section === "dashboard") redirect(ACCOUNTING_HOME);
  return <AccountingPageBody section={section} />;
}
