/**
 * Phase 27 Wave 8 — posting rules for the `items`-model stock operations.
 *
 * The industry's inventory account differs by trade (gold/watch/accessory/
 * cosmetics each have their own finished-goods account), so the rules resolve
 * the business's industry live and pick the matching well-known code — the
 * same "resolve against the current record" instinct accountIdsByCode uses.
 *
 *   - purchase received:  Debit {industry}Inventory / Credit accounts payable
 *   - supplier return:    Debit settlement account / Credit {industry}Inventory
 *   - transfer ship:      Debit inventory-in-transit / Credit {industry}Inventory
 *   - transfer receive:   Debit {industry}Inventory / Credit inventory-in-transit
 */
import type { PoolClient } from "pg";
import { WELL_KNOWN_CODES } from "./coa-template";
import { rialBigInt, type RialText } from "./inventory-exact";
import type { Industry } from "./industries";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";

const ZERO = "0" as RialText;

const INVENTORY_CODE_BY_INDUSTRY: Record<Industry, string> = {
  food_service: WELL_KNOWN_CODES.inventory,
  jewelry: WELL_KNOWN_CODES.goldInventory,
  watch: WELL_KNOWN_CODES.watchInventory,
  accessories: WELL_KNOWN_CODES.accessoryInventory,
  cosmetics: WELL_KNOWN_CODES.cosmeticInventory,
};

async function inventoryCodeForBusiness(client: PoolClient, businessId: string): Promise<string> {
  const { rows } = await client.query<{ industry: Industry }>(
    `SELECT industry FROM businesses WHERE id = $1`,
    [businessId],
  );
  return INVENTORY_CODE_BY_INDUSTRY[rows[0]?.industry ?? "food_service"];
}

interface AmountPayload {
  amount: RialText;
}

registerPostingRule("retail.purchase_received", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as AmountPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const inventoryCode = await inventoryCodeForBusiness(client, event.businessId);
  const accounts = await accountIdsByCode(client, event.businessId, [inventoryCode, WELL_KNOWN_CODES.accountsPayable]);

  return {
    lines: [
      { accountId: accounts.get(inventoryCode)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.accountsPayable)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "خرید کالای خرده‌فروشی",
    postingKind: "retail_purchase",
  };
});

const RETURN_DEBIT_CODE: Record<string, string> = {
  cash: WELL_KNOWN_CODES.cash,
  bank: WELL_KNOWN_CODES.bankClearing,
  supplier_receivable: WELL_KNOWN_CODES.supplierReceivable,
  accounts_payable: WELL_KNOWN_CODES.accountsPayable,
};

interface ReturnPayload extends AmountPayload {
  settlementMethod: string;
}

registerPostingRule("retail.supplier_return", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as ReturnPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const inventoryCode = await inventoryCodeForBusiness(client, event.businessId);
  const debitCode = RETURN_DEBIT_CODE[payload.settlementMethod] ?? WELL_KNOWN_CODES.accountsPayable;
  const accounts = await accountIdsByCode(client, event.businessId, [debitCode, inventoryCode]);

  return {
    lines: [
      { accountId: accounts.get(debitCode)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(inventoryCode)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "برگشت به تأمین‌کننده",
    postingKind: "retail_supplier_return",
  };
});

registerPostingRule("retail.transfer_ship", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as AmountPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const inventoryCode = await inventoryCodeForBusiness(client, event.businessId);
  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.retailInventoryInTransit,
    inventoryCode,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.retailInventoryInTransit)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(inventoryCode)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "ارسال انتقال کالا",
    postingKind: "retail_transfer_ship",
  };
});

registerPostingRule("retail.transfer_receive", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as AmountPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const inventoryCode = await inventoryCodeForBusiness(client, event.businessId);
  const accounts = await accountIdsByCode(client, event.businessId, [
    inventoryCode,
    WELL_KNOWN_CODES.retailInventoryInTransit,
  ]);

  return {
    lines: [
      { accountId: accounts.get(inventoryCode)!, debit: payload.amount, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.retailInventoryInTransit)!, debit: ZERO, credit: payload.amount },
    ],
    memo: "دریافت انتقال کالا",
    postingKind: "retail_transfer_receive",
  };
});
