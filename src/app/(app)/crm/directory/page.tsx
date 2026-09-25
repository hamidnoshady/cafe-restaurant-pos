import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/**
 * CRM → مشتریان. The customer directory — search, add, edit. Floor work.
 *
 * The member's effective permissions ride along so the section's buttons agree
 * with the API behind them: the directory's write gate is `parties.manage`, and
 * a cashier whose grant was revoked should see a read-only list rather than an
 * «افزودن» button that answers 403.
 */
export default async function CrmDirectoryPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions: ReadonlySet<string> = access?.permissions ?? new Set<string>();
  if (!canViewCrmSection(permissions, "directory")) redirect(crmFallbackHref(permissions));

  const member = await memberAccessFor(session);
  return (
    <CrmSection
      section="directory"
      role={member?.role ?? session.role}
      permissions={member ? [...member.permissions] : undefined}
    />
  );
}
