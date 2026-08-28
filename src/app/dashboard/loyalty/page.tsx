import { redirect } from "next/navigation";

/**
 * The loyalty page moved into the Growth & Marketing app (Phase 36b). This
 * route stays so every bookmark, saved bottom-nav slot and assistant link
 * keeps working — it forwards to the app on the loyalty section, which for a
 * cashier (the old page's floor audience) is where the app drops them anyway.
 */
export default function LoyaltyRedirect() {
  redirect("/dashboard/growth?section=loyalty");
}
