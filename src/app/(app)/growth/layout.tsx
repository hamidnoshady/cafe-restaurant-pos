import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { canOpenGrowth } from "./growth-routes";
import { GrowthAppShell } from "./growth-app-shell";

/**
 * The Growth & Marketing app's layout (Phase 36b, revised again).
 *
 * Two layers make the app, and they are deliberately in different places:
 *
 * - the **main menu** lives in the dashboard's sidebar slot, taken over for
 *   every `/growth` route by `src/lib/app-shells.ts` (its entries are
 *   `growth-app-nav.tsx`);
 * - the **page chrome** is this layout's shell — the app's header over the
 *   section the route renders.
 *
 * Splitting them is the point: with the menu inside the shell it sat next to the
 * business's own nav, accounting included, and read as a sub-menu of a page
 * rather than as the navigation of a separate app.
 *
 * The role gate stays here, server-side: a member who has no Growth surface
 * never lands in the app at all. Accountants are admitted only for the
 * customers screen with Growth's own columns, managed here on the shared record.
 */
export default async function GrowthLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  // The member's live effective permissions — the same set the API enforces,
  // so the page and the fetches inside it can never disagree about access.
  const access = await memberAccessFor(session);
  const permissions: ReadonlySet<string> = access?.permissions ?? new Set<string>();
  if (!canOpenGrowth(permissions)) redirect("/dashboard");

  return <GrowthAppShell>{children}</GrowthAppShell>;
}
