import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { CustomerFileSection } from "../../customer-file-section";
import { canViewCrmSection, crmFallbackHref } from "../../crm-routes";

/**
 * CRM → one customer's 360° file.
 *
 * Floor-accessible: the person on the phone needs to know when the last order
 * was and what the complaint was about. The consent *controls* inside the page
 * are owner/manager only — the role is passed down so the component can render
 * the state without offering the change.
 */
export default async function CrmCustomerFilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewCrmSection(session.role, "customers")) redirect(crmFallbackHref(session.role));

  const { id } = await params;
  return <CustomerFileSection customerId={id} role={session.role} />;
}
