import { redirect } from "next/navigation";

/**
 * Phase 42 — the خرازی catalogue lives in the shared products workspace now;
 * the old page forwards so saved links and bookmarks keep working.
 */
export default function HaberdasheryPage() {
  redirect("/dashboard/products");
}
