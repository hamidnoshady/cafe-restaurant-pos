import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { crmSectionHref } from "../crm-routes";

/**
 * `/crm/customers` — the address `persons` had before the rename, kept as a
 * permanent redirect.
 *
 * This used to be a full copy of the `persons` page tree (the page, the
 * picker, the detail route), which is how one screen becomes two that drift.
 * A redirect is the whole alias: bookmarks and middleware-forwarded
 * `/dashboard/crm/customers` links land on the one real page, and there is no
 * second copy of anything to keep honest.
 */
export default async function CrmCustomersAliasPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  redirect(crmSectionHref("persons"));
}
