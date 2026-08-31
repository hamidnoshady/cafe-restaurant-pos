import { DashboardPageSkeleton } from "./page-chrome";

/** Streaming fallback for every dashboard route, including nested CRM/growth pages. */
export default function DashboardLoading() {
  return <DashboardPageSkeleton />;
}
