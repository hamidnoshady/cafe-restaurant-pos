/**
 * Phase 29 — how an in-house production run reaches the ledger.
 *
 * Importing this module (for its side effect) registers every rule it defines
 * with posting-engine.ts's registry, exactly as fnb-posting-rules.ts and each
 * retail trade's `*-posting-rules.ts` do. A route that wants to post through
 * the engine must import this module before calling emitDomainEvent — see
 * `src/app/api/inventory/production/runs/route.ts`.
 *
 * One run posts three entries, all against the same source document:
 *
 *   1. `production.materials_issued`     DR 1310 WIP  / CR 1300 موجودی
 *   2. `production.conversion_absorbed`  DR 1310 WIP  / CR 5180 جذب‌شده
 *   3. `production.output_received`      DR 1300 موجودی / CR 1310 WIP
 *
 * They net to: inventory up by the conversion cost, 5180 credited by the same
 * amount, WIP zero. Posting the net directly would produce the same balances in
 * two lines — the three exist because the net says nothing about what happened,
 * and "how much did we put into production last month" should be answerable
 * from the general ledger rather than only from the production tables.
 *
 * 1310 is a wash account by construction here: a run issues and completes in
 * one transaction, so it can never carry a balance between them. The account
 * is nonetheless real rather than notional, so that a later phase which lets a
 * batch stay open across a period boundary already has the account and the
 * entry shape it needs.
 *
 * Why 5180 is credited rather than an expense being debited: the baker's wage
 * is already an expense (5200) and the oven's gas already an expense (5400).
 * Capitalising that effort into the cake must not book it twice, so absorbing
 * it credits a contra-expense which nets against those accounts in the period
 * the batch was made; the cost then re-emerges as COGS in the period the cake
 * is sold, which is where it belongs.
 *
 * Each leg carries its own `postingKind` because `uq_journal_business_source_posting`
 * (migration 0012) is unique on (business_id, source_type, source_id, posting_kind)
 * — three entries against one run is exactly what that index expects, and it is
 * also what makes the whole run idempotent if a retry ever replays it.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";
import type { RialText } from "./inventory-exact";

interface ProductionPostingPayload {
  amount: RialText;
  inventoryEventId?: string;
}

/**
 * Registers a two-line Debit/Credit rule, and returns `null` for a zero amount
 * so the engine records the event without posting an empty entry — a run with
 * no conversion cost is ordinary, not an error.
 */
function registerTransferRule(
  eventType: string,
  debitCode: string,
  creditCode: string,
  memo: string,
  postingKind: string,
): void {
  registerPostingRule(eventType, async (event, client): Promise<PostingResult | null> => {
    const { amount, inventoryEventId } = event.payload as unknown as ProductionPostingPayload;
    if (BigInt(amount) === 0n) return null;

    const accounts = await accountIdsByCode(client, event.businessId, [debitCode, creditCode]);
    const zero = "0" as RialText;

    return {
      lines: [
        { accountId: accounts.get(debitCode)!, debit: amount, credit: zero },
        { accountId: accounts.get(creditCode)!, debit: zero, credit: amount },
      ],
      memo,
      postingKind,
      inventoryEventId: inventoryEventId ?? null,
    };
  });
}

// Materials leave the store for the kitchen bench.
registerTransferRule(
  "production.materials_issued",
  WELL_KNOWN_CODES.workInProgress,
  WELL_KNOWN_CODES.inventory,
  "مصرف مواد در تولید",
  "production_materials",
);

// Labour/overhead the run capitalises into what it made.
registerTransferRule(
  "production.conversion_absorbed",
  WELL_KNOWN_CODES.workInProgress,
  WELL_KNOWN_CODES.appliedConversionCost,
  "جذب هزینهٔ تبدیل در تولید",
  "production_conversion",
);

// The finished batch arrives on the shelf, worth materials + conversion.
registerTransferRule(
  "production.output_received",
  WELL_KNOWN_CODES.inventory,
  WELL_KNOWN_CODES.workInProgress,
  "ورود محصول تولیدشده به انبار",
  "production_output",
);

// A reversal swaps every direction. Separate event types (rather than a signed
// amount on the three above) because `postingKind` has to differ from the
// original run's for the unique index to accept both against the same source
// document — and because the event log should say which one it was.
registerTransferRule(
  "production.materials_issue_reversed",
  WELL_KNOWN_CODES.inventory,
  WELL_KNOWN_CODES.workInProgress,
  "برگشت مصرف مواد در تولید",
  "production_materials_reversal",
);

registerTransferRule(
  "production.conversion_absorption_reversed",
  WELL_KNOWN_CODES.appliedConversionCost,
  WELL_KNOWN_CODES.workInProgress,
  "برگشت جذب هزینهٔ تبدیل",
  "production_conversion_reversal",
);

registerTransferRule(
  "production.output_receipt_reversed",
  WELL_KNOWN_CODES.workInProgress,
  WELL_KNOWN_CODES.inventory,
  "برگشت ورود محصول تولیدشده",
  "production_output_reversal",
);
