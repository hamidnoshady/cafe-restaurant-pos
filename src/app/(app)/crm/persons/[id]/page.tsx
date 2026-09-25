import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CustomerFileSection } from "../../customer-file-section";
import { canViewCrmSection, crmFallbackHref } from "../../crm-routes";

/**
 * CRM → one customer's 360° file.
 *
 * Floor-accessible: the person on the phone needs to know when the last order
 * was and what the complaint was about. The consent *controls* inside the page
 * need `crm.consent_manage`, so the member's effective permissions are passed
 * down (as an array — a Set does not cross into a client component) and the
 * component renders the state without offering the change.
 */
export default async function CrmCustomerFilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions: ReadonlySet<string> = access?.permissions ?? new Set<string>();
  if (!canViewCrmSection(permissions, "persons")) redirect(crmFallbackHref(permissions));

  const { id } = await params;
  return <CustomerFileSection customerId={id} permissions={[...permissions]} />;
}
