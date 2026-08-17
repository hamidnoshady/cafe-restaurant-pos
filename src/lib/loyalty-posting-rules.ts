/**
 * Phase 27 Wave 5 — store credit posting rules.
 *
 * Store credit is a real liability, never a number in a column. Issuing it
 * (e.g. a refund the customer takes as credit) debits «برگشت از فروش» (4400,
 * contra-revenue) and credits «اعتبار فروشگاهی» (2410); spending it debits
 * that liability and credits the tender that received the value. Both are
 * balanced journal entries posted through the domain-event engine, so the
 * trial balance carries the obligation and a customer's balance is
 * reconstructed from the events, the same discipline consignment-service.ts
 * follows for what is owed to a consignor.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import { rialBigInt, type RialText } from "./inventory-exact";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";
import type { SettlementMethod } from "./ledger";

const ZERO = "0" as RialText;

const CREDIT_TENDER_ACCOUNT_CODE: Record<Extract<SettlementMethod, "cash" | "bank">, string> = {
  cash: WELL_KNOWN_CODES.cash,
  bank: WELL_KNOWN_CODES.bankClearing,
};

interface StoreCreditIssuedPayload {
  customerId: string;
  amount: RialText;
}

registerPostingRule("loyalty.store_credit_issued", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as StoreCreditIssuedPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.salesReturns,
    WELL_KNOWN_CODES.storeCreditPayable,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.salesReturns)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.storeCreditPayable)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "صدور اعتبار فروشگاهی",
    postingKind: "loyalty_store_credit_issued",
  };
});

interface StoreCreditUsedPayload {
  customerId: string;
  amount: RialText;
  paymentMethod: Extract<SettlementMethod, "cash" | "bank">;
}

registerPostingRule("loyalty.store_credit_used", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as StoreCreditUsedPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const tenderCode = CREDIT_TENDER_ACCOUNT_CODE[payload.paymentMethod] ?? WELL_KNOWN_CODES.cash;
  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.storeCreditPayable,
    tenderCode,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.storeCreditPayable)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(tenderCode)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "مصرف اعتبار فروشگاهی",
    postingKind: "loyalty_store_credit_used",
  };
});
