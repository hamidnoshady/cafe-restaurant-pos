/**
 * Opening-balance helpers for the setup wizard's final step.
 * All amounts are integer Rial (see src/lib/money.ts).
 */

export interface OpeningLine {
  accountId: string;
  debit: number;
  credit: number;
}

export interface BalanceCheck {
  totalDebit: number;
  totalCredit: number;
  /** debit − credit; 0 means balanced */
  difference: number;
  balanced: boolean;
}

export function checkBalance(lines: OpeningLine[]): BalanceCheck {
  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of lines) {
    totalDebit += l.debit;
    totalCredit += l.credit;
  }
  const difference = totalDebit - totalCredit;
  return { totalDebit, totalCredit, difference, balanced: difference === 0 };
}

/** Persian error strings; empty array = valid. */
export function validateOpeningLines(lines: OpeningLine[]): string[] {
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
  const seen = new Set<string>();
  for (const l of nonZero) {
    if (seen.has(l.accountId)) {
      errors.push("برای هر حساب فقط یک سطر مجاز است.");
      break;
    }
    seen.add(l.accountId);
  }
  return errors;
}

/**
 * If the entry doesn't balance, add an offsetting line on the given equity
 * account («تراز افتتاحیه»). Returns the final, balanced set of lines.
 */
export function withAutoOffset(lines: OpeningLine[], offsetAccountId: string): OpeningLine[] {
  const nonZero = lines.filter((l) => l.debit !== 0 || l.credit !== 0);
  const { difference } = checkBalance(nonZero);
  if (difference === 0) return nonZero;
  const offset: OpeningLine =
    difference > 0
      ? { accountId: offsetAccountId, debit: 0, credit: difference }
      : { accountId: offsetAccountId, debit: -difference, credit: 0 };

  // Merge with an existing line for the offset account if there is one.
  const existing = nonZero.find((l) => l.accountId === offsetAccountId);
  if (existing) {
    const net = existing.debit - existing.credit + offset.debit - offset.credit;
    const merged: OpeningLine =
      net >= 0
        ? { accountId: offsetAccountId, debit: net, credit: 0 }
        : { accountId: offsetAccountId, debit: 0, credit: -net };
    const rest = nonZero.filter((l) => l.accountId !== offsetAccountId);
    return net === 0 ? rest : [...rest, merged];
  }
  return [...nonZero, offset];
}
