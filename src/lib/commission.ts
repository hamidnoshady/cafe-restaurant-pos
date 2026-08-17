/**
 * Phase 27 Wave 7 — sales-staff commission (pure, framework-free).
 *
 * Given a settled invoice line and the employee's applicable rules, compute
 * the accrual. The rules are resolved by specificity — item scope beats brand
 * beats category beats "everything" — and ties break by priority then id, so
 * two overlapping rules never both accrue and the answer is deterministic.
 * A margin-basis rule uses the same cost the COGS posting used (the caller
 * passes it in); a line with no attributable employee accrues nothing, which
 * is the caller's job to decide before this file is reached.
 */

export type CommissionKind = "percent" | "fixed";
export type CommissionBasis = "net" | "margin";

export interface CommissionRule {
  id: string;
  kind: CommissionKind;
  /** percent rate (0-100) or fixed Rial amount. */
  value: number;
  basis: CommissionBasis;
  /** Scope axes; an empty/absent set means "everything". */
  itemIds?: string[] | null;
  brandIds?: string[] | null;
  categoryIds?: string[] | null;
  priority?: number;
}

export interface CommissionLine {
  /** The line's net (after any discount, before VAT), Rial. */
  net: number;
  /** The line's cost of goods sold (the cost the COGS posting used); required for a margin basis. */
  cost?: number | null;
  itemId?: string;
  brandId?: string | null;
  categoryId?: string | null;
}

export interface CommissionAccrual {
  amount: number;
  ruleId: string | null;
}

/** Specificity: an item-scoped rule is more specific than a brand rule, which is more specific than a category rule, which is more specific than "everything". */
function specificity(rule: CommissionRule): number {
  if (rule.itemIds?.length) return 3;
  if (rule.brandIds?.length) return 2;
  if (rule.categoryIds?.length) return 1;
  return 0;
}

function matches(rule: CommissionRule, line: CommissionLine): boolean {
  if (rule.itemIds?.length && !(line.itemId && rule.itemIds.includes(line.itemId))) return false;
  if (rule.brandIds?.length && !(line.brandId && rule.brandIds.includes(line.brandId))) return false;
  if (rule.categoryIds?.length && !(line.categoryId && rule.categoryIds.includes(line.categoryId))) return false;
  return true;
}

/** The most specific matching rule wins; ties break by priority (higher first) then id, so the result is deterministic. */
export function resolveCommissionRule(line: CommissionLine, rules: CommissionRule[]): CommissionRule | null {
  const matching = rules.filter((r) => matches(r, line));
  if (matching.length === 0) return null;
  return matching.sort(
    (a, b) =>
      specificity(b) - specificity(a) ||
      (b.priority ?? 0) - (a.priority ?? 0) ||
      a.id.localeCompare(b.id),
  )[0];
}

/**
 * The Rial amount a rule is calculated on: net, or net − cost for a margin
 * basis. Uses the same cost the COGS posting used, so commission can never
 * disagree with the ledger.
 */
export function commissionBasis(line: CommissionLine, rule: CommissionRule): number {
  return rule.basis === "margin" ? line.net - (line.cost ?? 0) : line.net;
}

/**
 * The accrual for one line. A margin basis uses `cost` — the same cost the
 * COGS posting used — so it can never disagree with the ledger; a zero or
 * missing cost on a margin rule accrues nothing. A fixed amount is clamped to
 * the basis, so commission can never exceed the money it is calculated on.
 */
export function computeCommissionAccrual(line: CommissionLine, rules: CommissionRule[]): CommissionAccrual {
  const rule = resolveCommissionRule(line, rules);
  if (!rule) return { amount: 0, ruleId: null };

  const basis = commissionBasis(line, rule);
  if (basis <= 0) return { amount: 0, ruleId: rule.id };

  const amount =
    rule.kind === "percent" ? Math.round((basis * Math.max(0, Math.min(rule.value, 100))) / 100) : Math.round(rule.value);

  return { amount: Math.min(amount, basis), ruleId: rule.id };
}

/** Total a set of line accruals, for a per-staff report. */
export function totalCommission(accruals: CommissionAccrual[]): number {
  return accruals.reduce((sum, a) => sum + a.amount, 0);
}
