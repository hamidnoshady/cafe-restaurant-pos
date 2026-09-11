import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireFeatureForPage } from "@/lib/features";
import {
  accountingSectionForLegacyTab,
  accountingSectionHref,
  canOpenAccounting,
} from "../accounting/accounting-routes";

/**
 * The Accounting app's old address, forwarding onward.
 *
 * The app lived here as one tabbed page (`/dashboard/ledger?tab=…`); it has
 * its own prefix and its own naming now — `/dashboard/accounting/<section>`,
 * the persons directory at `/dashboard/accounting/directory` among them.
 * Bookmarks, saved bottom-nav slots and knowledge-base articles still point
 * at the old address, so every `?tab=` target forwards to the section it
 * names now (`parties` is the one rename — it is the directory). A `?party=`
 * deep link forwards with its file-opening parameter intact.
 *
 * The gates run before the forward, exactly as the page itself drew them: an
 * unentitled or unadmitted member is answered here rather than one hop later.
 * An unknown tab lands on the app's home, which is what the bare address
 * always landed on — a URL that used to work never becomes a dead end.
 */
export default async function LegacyLedgerRedirect({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; party?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canOpenAccounting(session.role)) redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "ledger");

  const { tab, party } = await searchParams;
  const section = accountingSectionForLegacyTab(tab ?? null);
  const href = accountingSectionHref(section);
  redirect(party ? `${href}?party=${encodeURIComponent(party)}` : href);
}
