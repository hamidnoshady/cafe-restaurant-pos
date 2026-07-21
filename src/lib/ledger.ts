/**
 * Double-entry ledger — pure functions (account balance/validation, and the
 * line-builders for each auto-posted event type). All amounts are integer
 * Rial (see src/lib/money.ts). DB orchestration (resolving account codes to
 * ids, inserting journal_entries/journal_lines) lives in ledger-service.ts.
 */
import type { Rial } from "./money";

export interface JournalLine {
  accountId: string;
  debit: Rial;
  credit: Rial;
}

export interface BalanceCheck {
  totalDebit: Rial;
  totalCredit: Rial;
  /** debit − credit; 0 means balanced */
  difference: Rial;
  balanced: boolean;
}

export function checkBalance(lines: JournalLine[]): BalanceCheck {
  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of lines) {
    totalDebit += l.debit;
    totalCredit += l.credit;
  }
  const difference = totalDebit - totalCredit;
  return { totalDebit, totalCredit, difference, balanced: difference === 0 };
}

/** Persian error strings; empty array = valid. Rejects an unbalanced or malformed entry. */
export function validateJournalLines(lines: JournalLine[]): string[] {
  const errors: string[] = [];
  const nonZero = lines.filter((l) => l.debit !== 0 || l.credit !== 0);
  if (nonZero.length === 0) {
    errors.push("حداقل یک سطر با مبلغ لازم است.");
    return errors;
  }
  for (const l of nonZero) {
    if (!l.accountId) errors.push("سطری بدون حساب وجود دارد.");
    if (!Number.isSafeInteger(l.debit) || l.debit < 0 || !Number.isSafeInteger(l.credit) || l.credit < 0) {
      errors.push("مبلغ‌ها باید عدد صحیح و نامنفی باشند.");
      break;
    }
  }
  for (const l of nonZero) {
    if (l.debit !== 0 && l.credit !== 0) {
      errors.push("هر سطر باید فقط بدهکار یا فقط بستانکار باشد.");
      break;
    }
  }
  if (!checkBalance(nonZero).balanced) {
    errors.push("مجموع بدهکار و بستانکار باید برابر باشد.");
  }
  return errors;
}

export interface OrderPaymentAccounts {
  cash: string;
  bankClearing: string;
  accountsReceivable: string;
  salesRevenue: string;
  vatPayable: string;
}

function paymentDebitAccount(accounts: OrderPaymentAccounts, method: string): string {
  switch (method) {
    case "cash":
      return accounts.cash;
    case "card":
    case "card_to_card":
    case "online":
      return accounts.bankClearing;
    case "credit":
      return accounts.accountsReceivable;
    default:
      throw new Error(`unknown_payment_method: ${method}`);
  }
}

/**
 * Order paid → Debit Cash/Bank-Clearing/Accounts-Receivable (by method) /
 * Credit Sales Revenue (amount net of tax) + Tax Payable.
 */
export function buildOrderPaymentLines(
  accounts: OrderPaymentAccounts,
  payment: { method: string; amount: Rial; tax: Rial },
): JournalLine[] {
  if (payment.amount <= 0) return [];
  const revenue = payment.amount - payment.tax;
  const lines: JournalLine[] = [{ accountId: paymentDebitAccount(accounts, payment.method), debit: payment.amount, credit: 0 }];
  if (revenue > 0) lines.push({ accountId: accounts.salesRevenue, debit: 0, credit: revenue });
  if (payment.tax > 0) lines.push({ accountId: accounts.vatPayable, debit: 0, credit: payment.tax });
  return lines;
}

/** Stock deducted on sale → Debit COGS / Credit Inventory Asset. */
export function buildCogsLines(accounts: { cogs: string; inventory: string }, totalCost: Rial): JournalLine[] {
  if (totalCost <= 0) return [];
  return [
    { accountId: accounts.cogs, debit: totalCost, credit: 0 },
    { accountId: accounts.inventory, debit: 0, credit: totalCost },
  ];
}

/** Waste logged → Debit Waste Expense / Credit Inventory Asset. */
export function buildWasteLines(accounts: { wasteExpense: string; inventory: string }, totalCost: Rial): JournalLine[] {
  if (totalCost <= 0) return [];
  return [
    { accountId: accounts.wasteExpense, debit: totalCost, credit: 0 },
    { accountId: accounts.inventory, debit: 0, credit: totalCost },
  ];
}

export type SettlementMethod = "cash" | "bank" | "credit";

/**
 * Purchase received → Debit Inventory Asset / Credit Accounts Payable
 * (supplier credit terms, the default) or Cash/Bank (paid immediately).
 */
export function buildPurchaseLines(
  accounts: { inventory: string; accountsPayable: string; cash: string; bankClearing: string },
  input: { total: Rial; settlementMethod: SettlementMethod },
): JournalLine[] {
  if (input.total <= 0) return [];
  const creditAccount =
    input.settlementMethod === "cash"
      ? accounts.cash
      : input.settlementMethod === "bank"
        ? accounts.bankClearing
        : accounts.accountsPayable;
  return [
    { accountId: accounts.inventory, debit: input.total, credit: 0 },
    { accountId: creditAccount, debit: 0, credit: input.total },
  ];
}
