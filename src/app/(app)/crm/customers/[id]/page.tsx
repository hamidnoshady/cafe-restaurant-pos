import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { crmCustomerHref } from "../../crm-routes";

/**
 * `/crm/customers/<id>` — the pre-rename address of one customer's 360° file,
 * redirected to `/crm/persons/<id>` rather than rendered by a second copy of
 * the file page (see the alias page beside this one).
 */
export default async function CrmCustomerFileAliasPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;
  redirect(crmCustomerHref(id));
}
