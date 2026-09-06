/**
 * Backfill `customers.phone_e164` using the real normaliser.
 *
 * Migration 0118 backfills the canonical phone itself, but deliberately only
 * for rows whose `phone` already matches an unambiguous Iranian mobile
 * pattern. Everything else — landlines, numbers with an extension typed in,
 * two numbers in one field, Persian digits a regex in SQL would have to
 * re-implement — is left NULL for this script, because deciding what those
 * strings mean is `src/lib/phone.ts`'s job and a migration must not carry a
 * second, drifting copy of that logic.
 *
 * The canonical phone is what duplicate detection, segment membership and any
 * future SMS send key off, so a row left NULL is a customer who quietly cannot
 * be found or reached. This script closes that gap.
 *
 * Read-only by default — it prints what it would change and, importantly, what
 * it *cannot* parse, so an operator can fix the source data. Nothing is written
 * without `--apply`.
 *
 *   npx tsx scripts/normalize-customer-phones.ts               # dry run, all businesses
 *   npx tsx scripts/normalize-customer-phones.ts --apply
 *   npx tsx scripts/normalize-customer-phones.ts --business <uuid> --apply
 *   npx tsx scripts/normalize-customer-phones.ts --recheck     # re-verify rows already filled
 *
 * Safety: it only ever writes `phone_e164`. The `phone` column a human typed is
 * never rewritten — the original is evidence, and an operator comparing the two
 * is how a bad normalisation gets caught.
 */
import "dotenv/config";
import { Client } from "pg";
import { normalizePhone } from "../src/lib/phone";

const apply = process.argv.includes("--apply");
const recheck = process.argv.includes("--recheck");
const businessArgIndex = process.argv.indexOf("--business");
const businessId = businessArgIndex >= 0 ? process.argv[businessArgIndex + 1] : null;

if (businessArgIndex >= 0 && !businessId) {
  console.error("--business needs a business id.");
  process.exit(2);
}

interface Row {
  id: string;
  business_id: string;
  name: string;
  phone: string | null;
  phone_e164: string | null;
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  // This is a maintenance script run by an operator against the whole
  // database, not a request on behalf of one tenant, so it bypasses RLS the
  // same way scripts/seed.ts does — explicitly, in one place, at the top.
  await client.query("SELECT set_config('app.rls_bypass', 'on', true)");

  const conditions = ["phone IS NOT NULL", "btrim(phone) <> ''"];
  const params: unknown[] = [];
  if (!recheck) conditions.push("phone_e164 IS NULL");
  if (businessId) {
    params.push(businessId);
    conditions.push(`business_id = $${params.length}`);
  }

  const { rows } = await client.query<Row>(
    `SELECT id::text, business_id::text, name, phone, phone_e164
       FROM parties
      WHERE ${conditions.join(" AND ")}
      ORDER BY business_id, name`,
    params,
  );

  const updates: { id: string; e164: string }[] = [];
  const unparsable: Row[] = [];
  const corrections: { row: Row; e164: string }[] = [];
  const landlines: { row: Row; e164: string }[] = [];

  for (const row of rows) {
    const normalized = normalizePhone(row.phone);
    if (!normalized.valid || !normalized.e164) {
      unparsable.push(row);
      continue;
    }
    if (row.phone_e164 === normalized.e164) continue;
    if (row.phone_e164 !== null) corrections.push({ row, e164: normalized.e164 });
    if (normalized.kind === "landline") landlines.push({ row, e164: normalized.e164 });
    updates.push({ id: row.id, e164: normalized.e164 });
  }

  console.log(`${apply ? "APPLY" : "DRY RUN"}: examined ${rows.length} customer(s) with a phone.`);
  console.log(`  ${updates.length} would get a canonical phone written.`);
  console.log(`  ${landlines.length} of those are landlines (kept, but no SMS can reach them).`);
  console.log(`  ${corrections.length} already had a canonical phone that disagrees with the normaliser.`);
  console.log(`  ${unparsable.length} could not be parsed and need a human.`);

  for (const { row, e164 } of corrections) {
    console.log(`  CHANGED  ${row.id}  ${row.phone_e164} -> ${e164}  (${row.name})`);
  }
  for (const row of unparsable) {
    console.log(`  UNPARSED ${row.id}  ${JSON.stringify(row.phone)}  (${row.name})`);
  }

  // A duplicate warning, because this script is usually what *creates* the
  // duplicates the CRM then finds: two rows that looked different as free text
  // become identical once canonicalised. Better to say so here than to let it
  // surprise someone on the duplicates screen.
  const seen = new Map<string, number>();
  for (const { id, e164 } of updates) {
    const row = rows.find((candidate) => candidate.id === id)!;
    const key = `${row.business_id}|${e164}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const collisions = [...seen.entries()].filter(([, count]) => count > 1);
  if (collisions.length > 0) {
    console.log(
      `  ${collisions.length} phone number(s) will now be shared by more than one customer — ` +
        "they will appear under «مشتریان تکراری» in the CRM for a human to merge.",
    );
  }

  if (!apply || updates.length === 0) {
    if (!apply) console.log("Nothing written. Re-run with --apply to write.");
    process.exit(0);
  }

  // One statement, one transaction: a half-normalised customer table would
  // make duplicate detection disagree with itself mid-run.
  await client.query("BEGIN");
  await client.query(
    `UPDATE parties AS c
        SET phone_e164 = v.e164
       FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS e164) AS v
      WHERE c.id = v.id`,
    [updates.map((u) => u.id), updates.map((u) => u.e164)],
  );
  await client.query("COMMIT");
  console.log(`Wrote ${updates.length} canonical phone number(s).`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
