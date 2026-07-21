import { NextResponse } from "next/server";
import { SAMPLE_CSV } from "@/lib/menu-import";

/** Downloadable CSV template for the menu import step. */
export async function GET() {
  return new NextResponse(SAMPLE_CSV, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="menu-template.csv"',
    },
  });
}
