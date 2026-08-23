import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { mintMissingBarcodes } from "@/lib/inventory-item-barcodes-service";

/**
 * Label the whole branch in one go: mint an internal barcode for every active
 * ingredient that has none, so a store room that has never been labelled can
 * be made scannable before its first count.
 *
 * One transaction, and idempotent — an ingredient that already has a code is
 * skipped, so running this twice is harmless and a run that failed halfway is
 * finished by repeating it.
 */
export const POST = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await mintMissingBarcodes(client, location.id);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    return NextResponse.json(
      { error: "barcode_failed", message: (err as Error).message },
      { status: 400 },
    );
  } finally {
    client.release();
  }
});
