import { redirect } from "next/navigation";
import { aiPanelHref } from "@/lib/ai-panel";

/**
 * Compatibility redirect: this assistant management section is no longer a
 * page of a second AI application — it is a section of the dashboard chat
 * home's «مدیریت دستیار» panel. Bookmarked URLs keep working, addressed the
 * way `aiPanelHref` names them, and the panel's own owner/manager gate
 * applies on arrival, exactly as the page's gate did here.
 */
export default function Page() {
  redirect(aiPanelHref("knowledge"));
}
