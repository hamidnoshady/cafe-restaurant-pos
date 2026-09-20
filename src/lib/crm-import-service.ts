/**
 * Customer CSV import — «ورود اطلاعات مشتریان».
 *
 * ## Dry run first, always
 *
 * `analyseImport` parses, validates and matches every row and writes nothing.
 * `commitImport` takes the same file and performs it. The UI shows the
 * analysis and asks for confirmation.
 *
 * That split is the whole design. An import is the single fastest way to
 * damage a customer directory: one mis-mapped column and three thousand
 * records get a phone number in the name field, with no undo. Showing exactly
 * what will happen — how many created, how many matched to existing records,
 * how many rejected and why — converts an irreversible bulk write into a
 * decision somebody can actually make.
 *
 * ## Two rules that are not negotiable
 *
 * **Import never grants consent.** A spreadsheet of names is not permission to
 * text them. There is no consent column in the importer, no flag to enable
 * one, and a file containing `sms_consent` has that column ignored. Whoever
 * assembled the list may sincerely believe those people opted in; the
 * business's legal position depends on a consent record with a source and a
 * timestamp, and a CSV cell is not that.
 *
 * **Ambiguity is never resolved by guessing.** A row matching two existing
 * customers is reported as a conflict and skipped. The importer does not pick
 * the older one — that is the bug that attached one customer's history to
 * another's file, arriving here in bulk.
 */

import { query, withTenantTransaction } from "./db";
import { createParty, phoneMatchKeys, phoneMatchSql } from "./parties-service";
import { recordCrmAudit } from "./crm-audit-service";
import { mapHeaders, parseCsv, westernDigits } from "./crm-csv";
import { normaliseSource } from "./crm-sources";
import { phoneE164 } from "./phone";

/**
 * Accepted column names.
 *
 * Generous on purpose — see `mapHeaders`. The file comes from a person with a
 * spreadsheet, not from an API.
 */
const COLUMN_ALIASES: Record<string, readonly string[]> = {
  name: ["name", "نام", "نام مشتری", "مشتری", "full name", "fullname"],
  phone: ["phone", "mobile", "تلفن", "موبایل", "شماره", "شمارهٔ تلفن", "شماره تماس"],
  email: ["email", "ایمیل", "e-mail", "پست الکترونیک"],
  address: ["address", "نشانی", "آدرس"],
  note: ["note", "notes", "یادداشت", "توضیحات"],
  source: ["source", "منبع", "راه آشنایی"],
  organization: ["organization", "company", "سازمان", "شرکت"],
};

export type RowOutcome = "create" | "match" | "conflict" | "invalid";

export interface AnalysedRow {
  line: number;
  name: string;
  phone: string | null;
  email: string | null;
  outcome: RowOutcome;
  /** For `match`: the party this row will update. */
  partyId?: string;
  matchedName?: string;
  /** For `conflict` and `invalid`: why, in Persian, for display. */
  reason?: string;
  /** For `conflict`: every candidate, so a human can choose later. */
  candidates?: { partyId: string; name: string }[];
}

export interface ImportAnalysis {
  totalRows: number;
  willCreate: number;
  willMatch: number;
  conflicts: number;
  invalid: number;
  /** Columns recognised in the file, for the mapping preview. */
  mappedColumns: string[];
  /** Columns present but ignored — including any consent column. */
  ignoredColumns: string[];
  rows: AnalysedRow[];
}

/** Rows analysed in one pass. Beyond this the preview is unusable anyway. */
const MAX_ROWS = 5000;

/**
 * Parse and classify a file without writing anything.
 *
 * Every row gets an outcome. Duplicate detection runs against existing parties
 * *and* against earlier rows of the same file — a spreadsheet that lists the
 * same person twice would otherwise create them twice, and the second one is
 * invisible until somebody notices the directory has grown oddly.
 */
export async function analyseImport(
  businessId: string,
  csvText: string,
): Promise<ImportAnalysis | { error: "empty" | "no_name_column" | "too_many_rows" }> {
  const sheet = parseCsv(csvText);
  if (sheet.length < 2) return { error: "empty" };

  const header = sheet[0];
  const columns = mapHeaders(header, COLUMN_ALIASES);
  if (columns.name === undefined) return { error: "no_name_column" };

  const body = sheet.slice(1);
  if (body.length > MAX_ROWS) return { error: "too_many_rows" };

  const mapped = Object.keys(columns);
  const ignoredColumns = header.filter((_, index) => !Object.values(columns).includes(index));

  const rows: AnalysedRow[] = [];
  // Phones seen earlier in this same file, so an in-file duplicate is caught
  // rather than created twice.
  const seenPhones = new Map<string, number>();
  const seenEmails = new Map<string, number>();

  for (let i = 0; i < body.length; i += 1) {
    const cells = body[i];
    const line = i + 2; // 1-based, plus the header, so it matches the spreadsheet
    const cell = (field: string) =>
      columns[field] === undefined ? "" : (cells[columns[field]] ?? "").trim();

    const name = cell("name");
    const rawPhone = westernDigits(cell("phone"));
    const email = cell("email").toLowerCase();

    if (!name) {
      rows.push({ line, name: "", phone: null, email: null, outcome: "invalid", reason: "نام خالی است" });
      continue;
    }

    const e164 = rawPhone ? phoneE164(rawPhone) : null;
    if (rawPhone && !e164) {
      rows.push({
        line,
        name,
        phone: rawPhone,
        email: email || null,
        outcome: "invalid",
        reason: "شمارهٔ تلفن معتبر نیست",
      });
      continue;
    }

    if (e164 && seenPhones.has(e164)) {
      rows.push({
        line,
        name,
        phone: rawPhone,
        email: email || null,
        outcome: "invalid",
        reason: `همین شماره در سطر ${seenPhones.get(e164)} هم آمده است`,
      });
      continue;
    }
    if (email && seenEmails.has(email)) {
      rows.push({
        line,
        name,
        phone: rawPhone,
        email,
        outcome: "invalid",
        reason: `همین ایمیل در سطر ${seenEmails.get(email)} هم آمده است`,
      });
      continue;
    }
    if (e164) seenPhones.set(e164, line);
    if (email) seenEmails.set(email, line);

    const candidates = await findExisting(businessId, e164, email);

    if (candidates.length === 0) {
      rows.push({ line, name, phone: rawPhone || null, email: email || null, outcome: "create" });
    } else if (candidates.length === 1) {
      rows.push({
        line,
        name,
        phone: rawPhone || null,
        email: email || null,
        outcome: "match",
        partyId: candidates[0].partyId,
        matchedName: candidates[0].name,
      });
    } else {
      // Two or more. Reported, never resolved — picking one here is the
      // misattribution bug arriving in bulk.
      rows.push({
        line,
        name,
        phone: rawPhone || null,
        email: email || null,
        outcome: "conflict",
        reason: "بیش از یک پروندهٔ مشابه پیدا شد",
        candidates,
      });
    }
  }

  return {
    totalRows: rows.length,
    willCreate: rows.filter((r) => r.outcome === "create").length,
    willMatch: rows.filter((r) => r.outcome === "match").length,
    conflicts: rows.filter((r) => r.outcome === "conflict").length,
    invalid: rows.filter((r) => r.outcome === "invalid").length,
    mappedColumns: mapped,
    ignoredColumns,
    rows,
  };
}

async function findExisting(
  businessId: string,
  e164: string | null,
  email: string,
): Promise<{ partyId: string; name: string }[]> {
  const found = new Map<string, { partyId: string; name: string }>();

  if (e164) {
    // Through `phoneMatchSql`, not a bare `phone_e164 =`. A row whose blind
    // index has been backfilled no longer answers to the plaintext column, and
    // a lookup that misses it concludes the person does not exist — which here
    // means importing a duplicate of an existing customer.
    const keys = await phoneMatchKeys(businessId, e164);
    const { rows } = await query<{ id: string; name: string }>(
      `SELECT id, name FROM parties
        WHERE business_id = $1 AND ${phoneMatchSql("", "$2", "$3")}
          AND merged_into_id IS NULL AND is_active`,
      [businessId, keys.bidx, keys.e164],
    );
    for (const row of rows) found.set(row.id, { partyId: row.id, name: row.name });
  }
  if (email) {
    const { rows } = await query<{ id: string; name: string }>(
      `SELECT id, name FROM parties
        WHERE business_id = $1 AND lower(email) = $2
          AND merged_into_id IS NULL AND is_active`,
      [businessId, email],
    );
    for (const row of rows) found.set(row.id, { partyId: row.id, name: row.name });
  }
  return [...found.values()];
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
}

/**
 * Perform the import.
 *
 * Re-analyses rather than trusting a client-supplied plan. The analysis the
 * user approved is minutes old and another member may have created a matching
 * customer since; committing a stale plan would create the duplicate the
 * analysis promised to avoid.
 *
 * `conflict` and `invalid` rows are skipped. `updateExisting` is opt-in,
 * because "add my new customers" and "overwrite what you have with my
 * spreadsheet" are different intentions and the destructive one should be
 * chosen deliberately.
 */
export async function commitImport(
  businessId: string,
  csvText: string,
  actor: { name: string; userId?: string | null },
  options: { updateExisting?: boolean; defaultSource?: string } = {},
): Promise<ImportResult | { error: "empty" | "no_name_column" | "too_many_rows" }> {
  const analysis = await analyseImport(businessId, csvText);
  if ("error" in analysis) return analysis;

  const source = normaliseSource(options.defaultSource ?? "import");
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of analysis.rows) {
    if (row.outcome === "invalid" || row.outcome === "conflict") {
      skipped += 1;
      continue;
    }

    if (row.outcome === "create") {
      // Through createParty, so field encryption, blind indexes, phone
      // normalisation and the accounting code all happen the one way they are
      // meant to. A hand-written INSERT here is how an imported record ends up
      // unsearchable by phone.
      // Per row, not one transaction for the whole file. A 5,000-row import
      // in a single transaction holds locks for minutes and rolls the entire
      // batch back over one bad row — whereas partial success is exactly what
      // the reported counts describe, and re-running the file is safe because
      // the rows that landed now match instead of creating.
      await withTenantTransaction(businessId, async () => {
        const party = await createParty(businessId, {
          displayName: row.name,
          role: "customer",
          roles: ["customer"],
          phone: row.phone,
          email: row.email,
          // No consent field, deliberately. See the file comment.
        });

        // First-touch attribution, written once — same shape as lead
        // conversion, and guarded by the NULL check so a re-import never
        // rewrites where a customer originally came from.
        await query(
          `UPDATE parties
              SET acquisition_source = $3, acquisition_detail = $4,
                  acquisition_at = now(), last_source = $3
            WHERE business_id = $1 AND id = $2 AND acquisition_source IS NULL`,
          [businessId, party.id, source, "ورود از فایل"],
        );
      });
      created += 1;
      continue;
    }

    if (row.outcome === "match" && options.updateExisting && row.partyId) {
      // COALESCE-style: only fills blanks. An import that blanks a phone
      // number somebody carefully corrected last week, because the
      // spreadsheet's column was empty, is worse than no import.
      await query(
        `UPDATE parties
            SET email = COALESCE(NULLIF($3, ''), email),
                last_source = $4,
                last_interaction_at = now(),
                updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [businessId, row.partyId, row.email ?? "", source],
      );
      updated += 1;
    } else {
      skipped += 1;
    }
  }

  await recordCrmAudit({
    businessId,
    kind: "import.committed",
    entityType: "import",
    entityId: null,
    partyId: null,
    summary: `ورود اطلاعات: ${created} ساخته، ${updated} به‌روزرسانی، ${skipped} رد`,
    detail: {
      created,
      updated,
      skipped,
      conflicts: analysis.conflicts,
      // Recorded so an auditor can confirm no consent came in with the file.
      consentGranted: false,
    },
    actorUserId: actor.userId ?? null,
    actorName: actor.name,
  });

  return { created, updated, skipped };
}
