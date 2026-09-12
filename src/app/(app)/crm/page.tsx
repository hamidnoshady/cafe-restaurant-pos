import { redirect } from "next/navigation";
import { crmSectionHref } from "./crm-routes";

/** The bare app prefix — the app's home is its overview. */
export default async function CrmIndexPage() {
  redirect(crmSectionHref("overview"));
}
