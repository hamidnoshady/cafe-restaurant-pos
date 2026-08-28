import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { GrowthAppShell } from "./growth-app-shell";

/**
 * The Growth & Marketing app's layout (Phase 36b, revised).
 *
 * The dashboard's global sidebar already points here; this layout adds the app's
 * own side menu and header around every Growth route, so the app reads as its
 * own product with its own navigation.
 */
export default async function GrowthLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "cashier"].includes(session.role)) redirect("/dashboard");

  return <GrowthAppShell role={session.role}>{children}</GrowthAppShell>;
}
