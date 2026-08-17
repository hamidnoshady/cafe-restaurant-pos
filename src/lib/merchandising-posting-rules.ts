/**
 * Phase 27 Wave 11 — the markdown write-down posting rule.
 *
 * Accepting a markdown on slow/dead/expiring stock lowers the inventory's
 * carrying value, so it posts Debit markdown expense / Credit the trade's
 * inventory account through the same domain-event engine every other
 * auto-posting uses. The payload carries the *specific* inventory account
 * code because cosmetics (1350) and accessories (1340) relieve different
 * asset accounts even though the markdown itself is one rule.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import { rialBigInt, type RialText } from "./inventory-exact";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";

const ZERO = "0" as RialText;

interface MarkdownPayload {
  /** The inventory account this trade relieves (WELL_KNOWN_CODES key, not a literal code). */
  inventoryAccountCode: string;
  amount: RialText;
}

registerPostingRule("item.markdown_write_down", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as MarkdownPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.inventoryWriteDownExpense,
    payload.inventoryAccountCode,
  ]);
  const expense = accounts.get(WELL_KNOWN_CODES.inventoryWriteDownExpense);
  const inventory = accounts.get(payload.inventoryAccountCode);
  if (!expense || !inventory) return null;

  return {
    lines: [
      { accountId: expense, debit: payload.amount, credit: ZERO },
      { accountId: inventory, debit: ZERO, credit: payload.amount },
    ],
    memo: "کاهش قیمت کالای کم‌فروش/راکد",
    postingKind: "markdown_write_down",
  };
});
