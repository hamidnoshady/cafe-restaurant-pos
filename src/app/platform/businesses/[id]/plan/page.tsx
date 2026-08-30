"use client";

/** Plan assignment and the usage snapshot it is bounded by. */
import { PlanPanel, UsagePanel } from "../panels";

export default function BusinessPlanPage() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <PlanPanel />
      <UsagePanel />
    </div>
  );
}
