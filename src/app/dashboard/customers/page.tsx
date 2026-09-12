import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { canOpenCrm } from "@/app/(app)/crm/crm-routes";
import { accountingCustomersHref } from "@/app/(app)/accounting/accounting-routes";

/**
 * `/dashboard/customers` → each role's own persons screen.
 *
 * The customer record used to live here as one flat page; it moved into the
 * apps, and the route stays as a permanent redirect target because it is
 * bookmarked, saved in members' mobile bottom-nav (`bottom-nav.ts` persists
 * hrefs in localStorage), and linked from older knowledge-base articles.
 *
 * The target depends on who is asking, because every app manages the shared
 * record from its own screen: the floor and the managers land on the CRM
 * directory, while the accountant — whom the CRM app does not admit — lands
 * on the canonical people directory filtered to customers
 * (`/accounting/directory?view=customers`) instead of being bounced out to the
 * dashboard from a screen their own nav offered them.
 */
export default async function CustomersPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role === "accountant") redirect(accountingCustomersHref());
  if (!canOpenCrm(session.role)) redirect("/dashboard");
  redirect("/crm/directory");
}
