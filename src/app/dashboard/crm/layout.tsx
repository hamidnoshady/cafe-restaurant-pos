import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { CrmAppShell } from "./crm-app-shell";
import { canOpenCrm } from "./crm-routes";

/**
 * The CRM app's layout (Phase 36).
 *
 * The role gate is here, server-side, so a member the app does not admit never
 * renders a single CRM screen — the per-page checks below it are the finer
 * cut (a cashier may open the directory but not the pipeline), not the door.
 *
 * `canOpenCrm` is derived from the same `canViewCrmSection` the menu uses, so
 * "who is let in" and "what they see once inside" cannot disagree: anyone with
 * at least one visible section is admitted, and everyone else is not.
 */
export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canOpenCrm(session.role)) redirect("/dashboard");

  return <CrmAppShell>{children}</CrmAppShell>;
}
