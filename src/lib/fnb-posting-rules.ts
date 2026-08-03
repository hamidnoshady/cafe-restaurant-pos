/**
 * Phase 21 Wave 1 — F&B's first posting rule registered against the engine.
 *
 * Importing this module (for its side effect) registers every rule it
 * defines with posting-engine.ts's registry. A route that wants to post
 * through the engine must import this module before calling
 * emitDomainEvent/dispatchDomainEvent — see inventory/waste/route.ts.
 *
 * `inventory.operational_posting` mirrors postExactOperationalInventoryEntry
 * (ledger-service.ts) exactly: a simple two-line entry (Debit debitCode /
 * Credit creditCode for one amount), parametrised by the caller rather than
 * hard-coded to one specific business event — postExactOperationalInventoryEntry
 * itself is unchanged and still directly used by
 * integration/exact-operational-consumption.integration.test.ts, so this is
 * a second, additive way to reach the same posting shape, not a replacement
 * for the first.
 */
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";
import type { RialText } from "./inventory-exact";

interface OperationalPostingPayload {
  debitCode: string;
  creditCode: string;
  amount: RialText;
  memo?: string;
  postingKind?: string;
  inventoryEventId?: string;
}

registerPostingRule("inventory.operational_posting", async (event, client): Promise<PostingResult | null> => {
  const { debitCode, creditCode, amount, memo, postingKind, inventoryEventId } =
    event.payload as unknown as OperationalPostingPayload;

  const accounts = await accountIdsByCode(client, event.businessId, [debitCode, creditCode]);
  const zero = "0" as RialText;

  return {
    lines: [
      { accountId: accounts.get(debitCode)!, debit: amount, credit: zero },
      { accountId: accounts.get(creditCode)!, debit: zero, credit: amount },
    ],
    memo: memo ?? null,
    postingKind: postingKind ?? null,
    inventoryEventId: inventoryEventId ?? null,
  };
});
