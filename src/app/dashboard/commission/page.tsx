import { redirect } from "next/navigation";

/**
 * Seller commission moved into the Growth & Marketing app (Phase 36b); this
 * route forwards to its section so old links land in the right place.
 */
export default function CommissionRedirect() {
  redirect("/growth/commission");
}
