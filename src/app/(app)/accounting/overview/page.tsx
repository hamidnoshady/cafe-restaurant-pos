import { AccountingPageBody } from "../accounting-page-body";

/**
 * `/accounting/overview` — the Accounting app's home (میز کار / داشبورد
 * حسابداری).
 *
 * A real, static route segment, so it wins over the `[section]` catch-all
 * beside it and — this is the point of the whole change — it is never
 * rewritten from `/dashboard/accounting`. `/accounting` itself redirects here,
 * so the home has exactly one address and `/accounting/overview` never
 * redirects to `/accounting/overview/overview`.
 */
export default async function AccountingOverviewPage() {
  return <AccountingPageBody section="dashboard" />;
}
