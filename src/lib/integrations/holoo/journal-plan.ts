/**
 * Phase 26 (issue #125) Wave 5 — the pure planning half of accounting import.
 *
 * The tie-out tools already exist (the `journal_lines_debit_xor_credit` DB
 * constraint and `checkBalance`/`validateJournalLines` in src/lib/ledger.ts) —
 * this phase *uses* them, it does not change them. This module is the pure
 * normalisation that sits in front of `postJournalEntry`:
 *  - a Holoo voucher line may carry both a debit and a credit (a net line); the
 *    app's invariant is one per line, so it is netted to a single side;
 *  - a voucher whose total debit ≠ total credit is a *discrepancy* and is
 *    reported, never balanced with a synthetic adjustment line.
 */
import type { Rial } from "../../money";

export interface HolooVoucherLine {
  accountCode: string;
  debitRial?: bigint | null;
  creditRial?: bigint | null;
}

export interface HolooVoucher {
  remoteId: string;
  /** ISO date. */
  entryDate: string;
  memo?: string | null;
  lines: HolooVoucherLine[];
}

/** One netted line — debit XOR credit, both non-negative. */
export interface NormalizedLine {
  accountCode: string;
  debit: Rial;
  credit: Rial;
}

/** Net a possibly-two-sided line to a single side. */
export function normalizeLine(line: HolooVoucherLine): NormalizedLine {
  const debit = line.debitRial ?? 0n;
  const credit = line.creditRial ?? 0n;
  const net = debit - credit;
  if (net >= 0n) return { accountCode: line.accountCode, debit: Number(net), credit: 0 };
  return { accountCode: line.accountCode, debit: 0, credit: Number(-net) };
}

export interface NormalizedVoucher {
  remoteId: string;
  entryDate: string;
  memo: string | null;
  lines: NormalizedLine[];
  balanced: boolean;
  difference: Rial;
}

export function normalizeVoucher(voucher: HolooVoucher): NormalizedVoucher {
  const lines = voucher.lines.map(normalizeLine);
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of lines) {
    totalDebit += line.debit;
    totalCredit += line.credit;
  }
  return {
    remoteId: voucher.remoteId,
    entryDate: voucher.entryDate,
    memo: voucher.memo ?? null,
    lines,
    balanced: totalDebit === totalCredit,
    difference: totalDebit - totalCredit,
  };
}

export interface JournalImportPlan {
  balanced: NormalizedVoucher[];
  unbalanced: NormalizedVoucher[];
}

/** Split vouchers into balanced (importable) and unbalanced (discrepancy). */
export function planJournalImport(vouchers: HolooVoucher[]): JournalImportPlan {
  const balanced: NormalizedVoucher[] = [];
  const unbalanced: NormalizedVoucher[] = [];
  for (const voucher of vouchers) {
    const normalized = normalizeVoucher(voucher);
    (normalized.balanced ? balanced : unbalanced).push(normalized);
  }
  return { balanced, unbalanced };
}
