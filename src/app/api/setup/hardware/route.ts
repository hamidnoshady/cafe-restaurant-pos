import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { markStepDone } from "@/lib/settings";
import { resolveActiveLocation, requireManager } from "@/lib/setup-state";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { withTenantScope } from "@/lib/auth";

/**
 * Step 7 — hardware pairing. Phase 5 builds the real print agent; this step
 * registers printers and exercises a STUB test-print / drawer-kick flow so the
 * pairing UX exists end-to-end.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireManager();
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ printers: [] });

  const { rows: printers } = await query(
    `SELECT id, name, kind, connection, is_active FROM printers
      WHERE location_id = $1 ORDER BY name`,
    [location.id],
  );
  return NextResponse.json({ printers });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  let body: {
    addPrinter?: { name?: string; kind?: string; ip?: string; port?: number };
    test?: { printerId?: string; target?: "print" | "drawer" };
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  if (body.addPrinter) {
    const name = body.addPrinter.name?.trim();
    const kind = body.addPrinter.kind === "kitchen" ? "kitchen" : "receipt";
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

    const connection = {
      ip: body.addPrinter.ip?.trim() || null,
      port: Number.isInteger(body.addPrinter.port) ? body.addPrinter.port : 9100,
      driver: "escpos-stub", // replaced by the real agent in Phase 5
    };
    const { rows } = await query(
      `INSERT INTO printers (location_id, name, kind, connection)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [location.id, name, kind, JSON.stringify(connection)],
    );
    const progress = await markStepDone(session.businessId, "hardware");
    return NextResponse.json({ ok: true, id: rows[0].id, progress });
  }

  if (body.test) {
    const { printerId } = body.test;
    const target = body.test.target === "drawer" ? "drawer" : "print";
    const { rows: printer } = await query(
      "SELECT id, name FROM printers WHERE id = $1 AND location_id = $2",
      [printerId, location.id],
    );
    if (printer.length === 0) {
      return NextResponse.json({ error: "printer_not_found" }, { status: 404 });
    }

    // Stub: no real ESC/POS output until Phase 5 — we log the attempt and
    // return the receipt text so the UI can show what would print.
    await query(
      `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, $3, $4, 'printer', $5, $6)`,
      [
        session.businessId,
        location.id,
        session.sub,
        target === "drawer" ? "hardware.drawer_test_stub" : "hardware.print_test_stub",
        printer[0].id,
        JSON.stringify({ printerName: printer[0].name }),
      ],
    );

    const now = new Date();
    const preview =
      target === "drawer"
        ? "فرمان باز شدن کشوی پول ارسال شد (آزمایشی)"
        : [
            "*** چاپ آزمایشی ***",
            `چاپگر: ${printer[0].name}`,
            `تاریخ: ${toPersianDigits(formatJalali(now, { withMonthName: true }))}`,
            "این یک رسید آزمایشی است.",
            "اتصال واقعی چاپگر در فاز ۵ فعال می‌شود.",
          ].join("\n");

    const progress = await markStepDone(session.businessId, "hardware");
    return NextResponse.json({ ok: true, stub: true, preview, progress });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});
