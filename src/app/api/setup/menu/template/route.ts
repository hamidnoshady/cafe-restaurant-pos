import { NextResponse } from "next/server";
import { SAMPLE_CSV } from "@/lib/menu-import";
import { requireManager } from "@/lib/setup-state";

/** Downloadable CSV template for the menu import step (Owner/Manager, like the rest of the wizard). */
export async function GET() {
  const { error } = await requireManager();
  if (error) return error;

  return new NextResponse(SAMPLE_CSV, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="menu-template.csv"',
    },
  });
}
