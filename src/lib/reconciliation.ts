/**
 * «تطبیق بانکی و صندوق» — the framework-free half.
 *
 * What a reconcilable account *is*, what a statement date may look like, and
 * how a set of candidate lines adds up. No database, no React: this is the
 * part `reconciliation.test.ts` covers, the part `reconciliation-service.ts`
 * consults before it writes anything, and the part the screen
 * (`reconciliation-section.tsx`) uses so the numbers it prints are computed by
 * the same code the server checks against.
 *
 * Why it exists: the three accounts, their Persian names and the arithmetic of
 * a reconciliation used to be written out three times — once in the service,
 * once in the assistant's labels and once in the screen — so «کارت‌خوان (در
 * راه)» could be renamed in one place and stay wrong in the other two, and the
 * screen's «مغایرت» was a second implementation of the rule the server refuses
 * a `complete` on.
 */

import { WELL_KNOWN_CODES } from "./coa-template";

export type ReconcilableAccount = "cash" | "bank" | "bankClearing";

export const RECONCILABLE_ACCOUNTS: readonly ReconcilableAccount[] = ["cash", "bank", "bankClearing"];

/**
 * The ledger code each reconcilable account posts to. بانک (۱۱۱۰) belongs here
 * because a cheque clears *into the bank* (Phase 30): a business taking cheques
 * had movements on 1110 and no way to reconcile the account this screen is
 * named after.
 */
export const RECONCILABLE_ACCOUNT_CODES: Record<ReconcilableAccount, string> = {
  cash: WELL_KNOWN_CODES.cash,
  bank: WELL_KNOWN_CODES.bank,
  bankClearing: WELL_KNOWN_CODES.bankClearing,
};

export interface ReconcilableAccountMeta {
  key: ReconcilableAccount;
  /** The account's short name, as the menu and the assistant both say it. */
  label: string;
  /** The ledger code, shown rather than hidden in a `title=` nobody on a touch screen can read. */
  code: string;
  /** One line about what lands on this account, so picking one is an informed choice. */
  hint: string;
}

export const RECONCILABLE_ACCOUNT_META: Record<ReconcilableAccount, ReconcilableAccountMeta> = {
  cash: {
    key: "cash",
    label: "صندوق",
    code: RECONCILABLE_ACCOUNT_CODES.cash,
    hint: "دریافت و پرداخت نقدی",
  },
  bank: {
    key: "bank",
    label: "بانک",
    code: RECONCILABLE_ACCOUNT_CODES.bank,
    hint: "وصول چک و انتقال بانکی",
  },
  bankClearing: {
    key: "bankClearing",
    label: "کارت‌خوان (در راه)",
    code: RECONCILABLE_ACCOUNT_CODES.bankClearing,
    hint: "مبالغ کارت‌خوان تا واریز به حساب",
  },
};

/** code → key, so a third account can never be mislabelled as the fallback. */
const ACCOUNT_KEYS_BY_CODE = new Map<string, ReconcilableAccount>(
  RECONCILABLE_ACCOUNTS.map((key) => [RECONCILABLE_ACCOUNT_CODES[key], key]),
);

export function isReconcilableAccount(value: unknown): value is ReconcilableAccount {
  return typeof value === "string" && (RECONCILABLE_ACCOUNTS as readonly string[]).includes(value);
}

/**
 * The account key a ledger code belongs to, or null.
 *
 * Null rather than a default: the two-way ternary this replaced read "cash,
 * else bankClearing", which reported every بانک reconciliation as a کارت‌خوان
 * one. A caller that cannot handle null has a data bug to surface, not a
 * fallback to invent.
 */
export function reconcilableAccountForCode(code: string): ReconcilableAccount | null {
  return ACCOUNT_KEYS_BY_CODE.get(code) ?? null;
}

/**
 * Is this a well-formed calendar date (`YYYY-MM-DD`), and a real day?
 *
 * Checked before the value reaches Postgres: a `date` column handed `"۱۴۰۴"`
 * or `"2025-13-45"` raises `invalid input syntax for type date`, which reaches
 * the accountant as a 500 and «خطای غیرمنتظره» rather than as "that date is
 * not a date".
 */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return false;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Is this a `journal_lines.id`? That column is `bigint GENERATED ALWAYS AS
 * IDENTITY`, so ids arrive as decimal strings — and `WHERE jl.id = $1` against
 * anything else raises `invalid input syntax for type bigint`, another 500
 * where a 404 was meant. Mirrors `isUuid` in `uuid.ts`, for the other id shape
 * this schema uses.
 */
export function isJournalLineId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,19}$/.test(value.trim());
}

export interface ReconciliationLine {
  journalLineId: string;
  entryDate: string;
  memo: string | null;
  sourceType: string | null;
  debit: number;
  credit: number;
  cleared: boolean;
}

export interface ReconciliationTotals {
  clearedCount: number;
  clearedTotal: number;
  unclearedCount: number;
  unclearedTotal: number;
  debitTotal: number;
  creditTotal: number;
}

/**
 * What a set of candidate lines adds up to.
 *
 * A line's contribution to the account is `debit - credit` — money in minus
 * money out — so a cleared credit *reduces* the cleared total. Summed in one
 * pass, and used by the service (to decide whether a `complete` is allowed)
 * and by the screen (to show the same number before it asks).
 */
export function reconciliationTotals(lines: readonly ReconciliationLine[]): ReconciliationTotals {
  const totals: ReconciliationTotals = {
    clearedCount: 0,
    clearedTotal: 0,
    unclearedCount: 0,
    unclearedTotal: 0,
    debitTotal: 0,
    creditTotal: 0,
  };
  for (const line of lines) {
    const net = line.debit - line.credit;
    totals.debitTotal += line.debit;
    totals.creditTotal += line.credit;
    if (line.cleared) {
      totals.clearedCount += 1;
      totals.clearedTotal += net;
    } else {
      totals.unclearedCount += 1;
      totals.unclearedTotal += net;
    }
  }
  return totals;
}

export interface ReconciliationBalances extends ReconciliationTotals {
  /** Opening balance + everything ticked off: what the books say the account holds. */
  computedBalance: number;
  /** Statement − computed. Zero is the only value a reconciliation may be locked at. */
  difference: number;
}

export function reconciliationBalances(params: {
  openingBalance: number;
  statementBalance: number;
  lines: readonly ReconciliationLine[];
}): ReconciliationBalances {
  const totals = reconciliationTotals(params.lines);
  const computedBalance = params.openingBalance + totals.clearedTotal;
  return {
    ...totals,
    computedBalance,
    difference: params.statementBalance - computedBalance,
  };
}

export type ReconciliationLineFilter = "all" | "cleared" | "uncleared";

/**
 * The lines a reader asked to see.
 *
 * A busy صندوق carries a *year* of order postings; without a search box and a
 * «تطبیق‌نشده» filter the only way through the list is the scrollbar. The
 * search matches the description, the source label and the amount as typed —
 * the three things somebody holding a bank statement actually reads off it.
 */
export function filterReconciliationLines(
  lines: readonly ReconciliationLine[],
  options: { query?: string; filter?: ReconciliationLineFilter; sourceLabel?: (sourceType: string | null) => string } = {},
): ReconciliationLine[] {
  const filter = options.filter ?? "all";
  const needle = (options.query ?? "").trim().toLowerCase();
  const sourceLabel = options.sourceLabel;
  return lines.filter((line) => {
    if (filter === "cleared" && !line.cleared) return false;
    if (filter === "uncleared" && line.cleared) return false;
    if (!needle) return true;
    const haystack = [
      line.memo ?? "",
      line.sourceType ?? "",
      sourceLabel ? sourceLabel(line.sourceType) : "",
      line.entryDate,
      String(line.debit),
      String(line.credit),
    ];
    return haystack.some((field) => field.toLowerCase().includes(needle));
  });
}

/**
 * May a reconciliation dated `statementDate` follow one dated `lastCompleted`?
 *
 * A reconciliation's opening balance is the previous *completed* one's
 * statement balance, so a new one dated before it would open with a balance
 * from its own future — the running total would be read backwards and the
 * «مغایرت» it shows would be meaningless. Equal dates are allowed: correcting
 * the same statement twice in one day is ordinary.
 */
export function isStatementDateAfterLast(statementDate: string, lastCompleted: string | null): boolean {
  if (!lastCompleted) return true;
  return statementDate >= lastCompleted;
}

/** The most a single bulk clear/un-clear may carry, so one request cannot ask for the whole ledger. */
export const MAX_RECONCILIATION_LINE_BATCH = 500;
