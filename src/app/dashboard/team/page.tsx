import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import { TeamManager } from "./team-manager";

/**
 * Phase 13 — team management.
 *
 * Gated on the `team.manage` permission rather than a role list, so an owner
 * who has granted it to a manager gets a working nav entry rather than a
 * redirect. The nav hiding is cosmetic; `/api/team/*` enforces the same
 * permission on every request.
 */
export default async function TeamPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  // The session's overrides aren't in the token, so this is the role preset
  // only — the API re-checks against the database, which is the real gate.
  if (!hasPermission(session.role, null, PERMISSIONS.teamManage)) redirect("/dashboard");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-bold">اعضای تیم</h1>
        <p className="text-sm text-muted-foreground">
          دعوت همکاران، تعیین نقش و دسترسی‌ها، و مدیریت کارکنان صندوق و آشپزخانه.
        </p>
      </div>
      <TeamManager currentUserId={session.sub} />
    </div>
  );
}
