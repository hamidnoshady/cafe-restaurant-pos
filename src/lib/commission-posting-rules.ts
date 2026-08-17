/**
 * Phase 27 Wave 7 — sales-staff commission posting rule.
 *
 * A commission accrual is a payroll liability, not a report-only number:
 * the moment a line accrues, Debit «پورسانت فروش» (5210) and Credit «حقوق
 * پرداختنی» (2300) through the same domain-event engine every other
 * auto-posting uses. The accrual row in `commission_accruals` is the signed
 * ledger of what each employee earned, and this entry is the liability it
 * always ties back to.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import { rialBigInt, type RialText } from "./inventory-exact";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";

const ZERO = "0" as RialText;

interface CommissionAccruedPayload {
  accrualId: string;
  employeeId: string;
  amount: RialText;
}

registerPostingRule("commission.accrued", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as CommissionAccruedPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.commissionExpense,
    WELL_KNOWN_CODES.salariesPayable,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.commissionExpense)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.salariesPayable)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "پورسانت فروشنده",
    postingKind: "commission_accrued",
  };
});
