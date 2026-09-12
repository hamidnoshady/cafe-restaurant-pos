import { redirect } from "next/navigation";
import { ACCOUNTING_HOME } from "./accounting-routes";

/**
 * The bare app prefix. The app's home is its overview, so `/accounting` sends
 * the visitor one hop to `/accounting/overview` rather than serving the same
 * page at two addresses.
 */
export default async function AccountingIndexPage() {
  redirect(ACCOUNTING_HOME);
}
