import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { WpAppShell } from "./wp-app-shell";

/**
 * The WordPress & WooCommerce Manager app's layout.
 *
 * Owner/manager only, matching the integrations surface it supersedes: every
 * page here writes to a live shopfront or sees the whole customer book. The
 * sidebar slot is owned by src/lib/app-shells.ts (which hands it to
 * wp-app-nav.tsx); this layout only gates and frames.
 */
export default async function WpManagerLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");

  return <WpAppShell>{children}</WpAppShell>;
}
