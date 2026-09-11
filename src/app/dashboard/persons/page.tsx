import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { canOpenCrm } from "../crm/crm-routes";
import { accountingSectionHref } from "../accounting/accounting-routes";

/**
 * `/dashboard/persons` → each role's own persons screen.
 *
 * The old flat «اشخاص» page was absorbed by the apps, and this address is
 * still held by saved bottom-nav slots and referenced by the workspace rail's
 * CRM launcher — but no page ever answered it, so it was a dead end. It
 * answers now, with the same role split the flat «مشتریان» page
 * (`/dashboard/customers`) draws: the floor and the managers land on the CRM's
 * directory, while the accountant — whom the CRM app does not admit — lands on
 * Accounting's own persons directory (`/dashboard/accounting/directory`)
 * rather than being bounced out to the dashboard.
 */
export default async function PersonsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role === "accountant") redirect(accountingSectionHref("directory"));
  if (!canOpenCrm(session.role)) redirect("/dashboard");
  redirect("/dashboard/crm/directory");
}
