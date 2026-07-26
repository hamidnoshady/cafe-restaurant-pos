import { NextResponse } from "next/server";
import { SAMPLE_CSV } from "@/lib/menu-import";
import { requireManager } from "@/lib/setup-state";
import { withTenantScope } from "@/lib/auth";

/** Downloadable CSV template for the menu import step (Owner/Manager, like the rest of the wizard). */
export const GET = withTenantScope(async () => {
  const { error } = await requireManager();
  if (error) return error;

  return new NextResponse(SAMPLE_CSV, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="menu-template.csv"',
    },
  });
});
