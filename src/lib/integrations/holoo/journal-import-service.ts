/**
 * Phase 26 (issue #125) Wave 5 — accounting import (vouchers, general ledger,
 * opening balance, debit/credit tie-out).
 *
 * The tie-out tools already exist — the `journal_lines_debit_xor_credit` DB
 * constraint and `checkBalance`/`validateJournalLines` in src/lib/ledger.ts —
 * and this phase *uses* them unchanged. Every balanced voucher is posted
 * through `postJournalEntry` (which re-validates balance), with a
 * `source_type` marking it imported; an unbalanced voucher is reported as a
 * discrepancy, never balanced with a synthetic adjustment line. The opening
 * balance uses the app's own opening mechanism (`withAutoOffset` on the تراز
 * افتتاحیه equity account) — the one place a synthetic offset is legitimate.
 */
import { getPool, query } from "../../db";
import { getConnection } from "../connections-service";
import { accountIdsByCode, postJournalEntry } from "../../ledger-service";
import { WELL_KNOWN_CODES } from "../../coa-template";
import { withAutoOffset } from "../../opening";
import { upsertMapping } from "../mapping-service";
import { planJournalImport, type HolooVoucher } from "./journal-plan";
import { writeIntegrationAudit } from "../audit";

export const HOLOO_IMPORT_SOURCE_TYPE = "holoo_import";

async function accountIdForCode(businessId: string, code: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE business_id = $1 AND code = $2`,
    [businessId, code],
  );
  return rows[0]?.id ?? null;
}

export interface JournalImportSummary {
  imported: number;
  unbalanced: { remoteId: string; difference: number }[];
  unmappedAccounts: { remoteId: string; accountCode: string }[];
}

export async function importJournalVouchers(
  businessId: string,
  connectionId: string,
  vouchers: HolooVoucher[],
  createdBy: string | null,
): Promise<JournalImportSummary> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection) throw new Error("not_found");

  const { balanced, unbalanced } = planJournalImport(vouchers);
  const unmappedAccounts: JournalImportSummary["unmappedAccounts"] = [];

  const client = await getPool().connect();
  try {
    let imported = 0;
    for (const voucher of balanced) {
      const lines = [];
      let hasUnmapped = false;
      for (const line of voucher.lines) {
        if (line.debit === 0 && line.credit === 0) continue;
        const accountId = await accountIdForCode(businessId, line.accountCode);
        if (!accountId) {
          unmappedAccounts.push({ remoteId: voucher.remoteId, accountCode: line.accountCode });
          hasUnmapped = true;
          break;
        }
        lines.push({ accountId, debit: line.debit, credit: line.credit });
      }
      if (hasUnmapped || lines.length === 0) continue;

      await client.query("BEGIN");
      try {
        const entryId = await postJournalEntry(client, {
          businessId,
          locationId: connection.location_id,
          entryDate: voucher.entryDate.slice(0, 10),
          memo: voucher.memo,
          sourceType: HOLOO_IMPORT_SOURCE_TYPE,
          sourceId: null,
          lines,
          createdBy,
        });
        if (entryId) {
          await upsertMapping(businessId, connectionId, "holoo_journal", voucher.remoteId, entryId);
          imported += 1;
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    await writeIntegrationAudit({
      businessId,
      connectionId,
      action: "journal.imported",
      payload: { imported, unbalanced: unbalanced.length },
    });
    return {
      imported,
      unbalanced: unbalanced.map((v) => ({ remoteId: v.remoteId, difference: v.difference })),
      unmappedAccounts,
    };
  } finally {
    client.release();
  }
}

export interface OpeningBalanceLine {
  accountCode: string;
  debitRial?: bigint | null;
  creditRial?: bigint | null;
}

/** Import the opening balance as the app's opening document (equity-offset). */
export async function importOpeningBalance(
  businessId: string,
  connectionId: string,
  lines: OpeningBalanceLine[],
  createdBy: string | null,
): Promise<{ entryId: string | null; unmappedAccounts: string[] }> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection) throw new Error("not_found");

  const openingLines: { accountId: string; debit: number; credit: number }[] = [];
  const unmappedAccounts: string[] = [];
  for (const line of lines) {
    const accountId = await accountIdForCode(businessId, line.accountCode);
    if (!accountId) {
      unmappedAccounts.push(line.accountCode);
      continue;
    }
    openingLines.push({ accountId, debit: Number(line.debitRial ?? 0n), credit: Number(line.creditRial ?? 0n) });
  }

  // The app's own opening mechanism: balance against the equity offset account.
  const client = await getPool().connect();
  try {
    let offsetId: string;
    try {
      offsetId = (await accountIdsByCode(client, businessId, [WELL_KNOWN_CODES.openingEquity])).get(WELL_KNOWN_CODES.openingEquity)!;
    } catch {
      return { entryId: null, unmappedAccounts };
    }

    const balanced = withAutoOffset(openingLines, offsetId);
    await client.query("BEGIN");
    const entryId = await postJournalEntry(client, {
      businessId,
      locationId: connection.location_id,
      entryDate: null,
      memo: "ماندهٔ افتتاحیه (واردشده از هلو)",
      sourceType: "opening",
      sourceId: null,
      lines: balanced,
      createdBy,
    });
    await client.query("COMMIT");
    return { entryId, unmappedAccounts };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
