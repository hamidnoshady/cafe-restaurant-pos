import { redirect } from "next/navigation";

/**
 * The old quick-report dashboard's address — a compatibility redirect.
 *
 * The operational overview (today's sales cards, order counts, the trend
 * chart) no longer exists as a home: `/dashboard` is the assistant chat home
 * for every tenant, and the real figures live in the apps that own them —
 * «حسابداری» has its own dashboard at `/accounting/overview`, and the daily
 * reports under «گزارش‌ها». Old bookmarks land somewhere real, not on a 404.
 */
export default function OverviewPage() {
  redirect("/dashboard");
}
