import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { GrowthAppShell } from "./growth-app-shell";

/**
 * The Growth & Marketing app's layout (Phase 36b, revised again).
 *
 * Two layers make the app, and they are deliberately in different places:
 *
 * - the **main menu** lives in the dashboard's sidebar slot, taken over for
 *   every `/dashboard/growth` route by `src/lib/app-shells.ts` (its entries are
 *   `growth-app-nav.tsx`);
 * - the **page chrome** is this layout's shell — the app's header over the
 *   section the route renders.
 *
 * Splitting them is the point: with the menu inside the shell it sat next to the
 * business's own nav, accounting included, and read as a sub-menu of a page
 * rather than as the navigation of a separate app.
 *
 * The role gate stays here, server-side: a member who is not owner, manager or
 * cashier never lands in the app at all.
 */
export default async function GrowthLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "cashier"].includes(session.role)) redirect("/dashboard");

  return <GrowthAppShell>{children}</GrowthAppShell>;
}
