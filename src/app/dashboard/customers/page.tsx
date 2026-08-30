import { redirect } from "next/navigation";

/**
 * `/dashboard/customers` → the CRM app's directory (Phase 36).
 *
 * The page itself moved: the customer record is the CRM's, and a directory
 * reachable from two places is a directory whose two copies drift. The route
 * stays as a permanent redirect target because it is bookmarked, saved in
 * members' mobile bottom-nav (`bottom-nav.ts` persists hrefs in localStorage),
 * and linked from older knowledge-base articles.
 *
 * No session check here on purpose — the CRM layout does the role gate, and
 * duplicating it would mean two answers to "who may see customers".
 */
export default function CustomersPage() {
  redirect("/dashboard/crm/directory");
}
