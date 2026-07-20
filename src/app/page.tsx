import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { hasAnyUser, isSetupComplete } from "@/lib/setup-state";

export default async function Home() {
  const session = await getSession();
  if (!session) {
    // Empty install → first-run wizard; otherwise normal login.
    redirect((await hasAnyUser()) ? "/login" : "/welcome");
  }
  // Owner/Manager land in the wizard until setup is finished.
  if (
    (session.role === "owner" || session.role === "manager") &&
    !(await isSetupComplete(session.businessId))
  ) {
    redirect("/setup");
  }
  redirect("/dashboard");
}
