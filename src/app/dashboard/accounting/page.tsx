import { AccountingPageBody } from "./accounting-page-body";

/**
 * The Accounting app — its home and first section (میز کار / داشبورد حسابداری).
 *
 * The app used to live at `/dashboard/ledger` as one tabbed page; it has its
 * own prefix and its own naming now, one route per section, the way the CRM
 * and Growth apps live at `/dashboard/crm` and `/dashboard/growth`. The old
 * address still forwards here (see `src/app/dashboard/ledger/page.tsx`), so a
 * bookmark or a saved bottom-nav slot never becomes a dead end.
 */
export default async function AccountingHomePage() {
  return <AccountingPageBody section="dashboard" />;
}
