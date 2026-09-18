/**
 * «سند دستی» — the rules of a manual journal document, as pure functions.
 *
 * The screen (`manual-entry-section.tsx`) and the service
 * (`manual-journal-service.ts`) have to agree about what a valid document is,
 * because the screen's summary panel is the only check most people read before
 * pressing «ثبت پیش‌نویس». When the two disagreed, the disagreement always took
 * the same shape: a green «متوازن» above a form whose submission came back as a
 * red server error. Two real cases —
 *
 *   - «صندوق بدهکار ۱۰٬۰۰۰ / صندوق بستانکار ۱۰٬۰۰۰» balances arithmetically, so
 *     the screen enabled the button; it is one account netting to zero, which
 *     the ledger should never be asked to carry;
 *   - a row whose amount could not be parsed contributed 0 to the on-screen
 *     total while being dropped from the payload, so the totals matched on
 *     screen and `not_balanced` came back from the API.
 *
 * So the rules live here once, framework-free, and both sides import them.
 * Pure and side-effect-free by design — per CLAUDE.md that makes them unit
 * testable directly (`manual-journal.test.ts`), unlike the DB-touching service.
 */

/** Caps on one manual document — see `manualDocumentProblem` for why each exists. */
export const MANUAL_MEMO_MAX = 500;
export const MANUAL_LINES_MAX = 200;

/** A document row as both sides hold it: integer Rial, debit XOR credit. */
export interface ManualJournalLine {
  accountId: string;
  debit: number;
  credit: number;
}

/**
 * The error code a document would be refused with, or `null` when it is
 * postable. The order matters: it is the order a person would fix the problems
 * in, and the screen turns the same codes into the sentence under its disabled
 * button.
 */
export type ManualJournalProblem =
  | "no_lines"
  | "too_many_lines"
  | "invalid_line"
  | "too_few_lines"
  | "single_account_entry"
  | "not_balanced";

/** The rows that actually become a document: everything with an amount on it. */
export function nonZeroLines<T extends ManualJournalLine>(lines: readonly T[]): T[] {
  return lines.filter((l) => l.debit !== 0 || l.credit !== 0);
}

/** Debit and credit totals as BigInt, so a large document cannot lose precision. */
export function manualJournalTotals(lines: readonly ManualJournalLine[]): {
  totalDebit: bigint;
  totalCredit: bigint;
  difference: bigint;
} {
  const totalDebit = lines.reduce((sum, l) => sum + BigInt(l.debit), 0n);
  const totalCredit = lines.reduce((sum, l) => sum + BigInt(l.credit), 0n);
  return { totalDebit, totalCredit, difference: totalDebit - totalCredit };
}

/**
 * What is wrong with this set of rows, or `null` if nothing is.
 *
 * `lines` is the *submitted* set — rows the caller has already decided are
 * complete. The screen filters incomplete rows out before calling this (and
 * reports them separately), exactly as the API's payload does.
 */
export function manualDocumentProblem(
  lines: readonly ManualJournalLine[],
): ManualJournalProblem | null {
  const rows = nonZeroLines(lines);
  if (rows.length === 0) return "no_lines";
  // A document with thousands of rows is a script or a mistake, not something
  // typed into the form, and every row is another INSERT inside the approval's
  // single transaction.
  if (rows.length > MANUAL_LINES_MAX) return "too_many_lines";
  for (const l of rows) {
    if (
      !l.accountId ||
      !Number.isSafeInteger(l.debit) ||
      l.debit < 0 ||
      !Number.isSafeInteger(l.credit) ||
      l.credit < 0 ||
      (l.debit !== 0 && l.credit !== 0)
    ) {
      return "invalid_line";
    }
  }
  // Double entry: at least two rows, naming at least two accounts. One account
  // debited and credited for the same amount balances and means nothing, and
  // because only a manual entry is reversible (and a reversal is not), the
  // ledger would carry the pair for ever.
  if (rows.length < 2) return "too_few_lines";
  if (new Set(rows.map((l) => l.accountId)).size < 2) return "single_account_entry";
  if (manualJournalTotals(rows).difference !== 0n) return "not_balanced";
  return null;
}

/** Whether a memo is present and within the stored column's sane length. */
export function manualMemoProblem(memo: string): "memo_required" | "memo_too_long" | null {
  const trimmed = memo.trim();
  if (!trimmed) return "memo_required";
  // `memo` is `text` in Postgres, so without this an accidental paste of a
  // whole invoice was stored in full and drawn untruncated in the review queue,
  // pushing every other draft off the screen.
  if (trimmed.length > MANUAL_MEMO_MAX) return "memo_too_long";
  return null;
}
