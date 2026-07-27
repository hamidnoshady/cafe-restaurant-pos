import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { computeSetupState, isSetupComplete } from "@/lib/setup-state";
import { STEPS } from "./steps";

/** /setup → jump to the first incomplete step (or the finish page). */
export default async function SetupIndex() {
  const session = await getSession();
  if (!session) redirect("/login");

  if (await isSetupComplete(session.businessId)) redirect("/dashboard/settings");

  const state = await computeSetupState(session.businessId);
  const firstIncomplete = STEPS.find((s) => !state.progress.steps[s.id]);
  redirect(firstIncomplete ? firstIncomplete.path : "/setup/finish");
}
