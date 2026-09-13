import { redirect } from "next/navigation";

/**
 * Phase 42 — the بدلیجات catalogue lives in the shared products workspace
 * now; the old page forwards so saved links and bookmarks keep working.
 */
export default function AccessoriesPage() {
  redirect("/accounting/products");
}
