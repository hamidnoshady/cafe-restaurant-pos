import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { SectionCard } from "../../page-chrome";
import { canViewCrmSection, crmFallbackHref, crmSectionHref } from "../crm-routes";
import { CustomerPicker } from "./customer-picker";

/**
 * CRM → «پروندهٔ مشتری» with nobody selected.
 *
 * The menu entry has to lead somewhere, and a file needs a customer, so this is
 * the picker: search, then open. It exists rather than redirecting to the
 * directory because the two screens answer different questions — the directory
 * manages records, the file explains one person — and collapsing them would
 * make the menu entry a lie.
 */
export default async function CrmCustomerIndexPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewCrmSection(session.role, "customers")) redirect(crmFallbackHref(session.role));

  return (
    <SectionCard
      title="پروندهٔ مشتری"
      description="نام یا شمارهٔ مشتری را جست‌وجو کنید تا پروندهٔ کاملش باز شود."
    >
      <CustomerPicker directoryHref={crmSectionHref("directory")} />
    </SectionCard>
  );
}
