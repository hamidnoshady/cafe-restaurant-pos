import { redirect } from "next/navigation";

/**
 * Campaigns and gift cards moved into the Growth & Marketing app (Phase 36b).
 * The old route forwards to the campaigns section; the gift-card counter is
 * the app's own section, one tap deeper.
 */
export default function PromotionsRedirect() {
  redirect("/dashboard/growth?section=campaigns");
}
