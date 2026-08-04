/**
 * DB-touching ledger orchestration (not unit-tested directly, per repo
 * convention — pure logic lives in ledger.ts and is what's covered by
 * ledger.test.ts).
 *
 * Everything here runs inside a caller-supplied transaction (`client`) so a
 * journal entry is always atomic with whatever triggered it (order payment,
 * a purchase receipt, a waste entry).
 */
import type { PoolClient } from "pg";
import { WELL_KNOWN_CODES } from "./coa-template";
import {
  buildCogsLines,
  buildOrderPaymentLines,
  buildPurchaseLines,
  buildWasteLines,
  checkBalance,
  revenueAccountCodeForOrderChannel,
  validateJournalLines,
  type JournalLine,
  type OrderChannel,
  type SettlementMethod,
} from "./ledger";
import type { Rial } from "./money";
import { rialBigInt, type RialText } from "./inventory-exact";

/**
 * Thrown when an auto-posting event needs a well-known account (by Chart of
 * Accounts code) that doesn't exist for this business — e.g. it was removed
 * while customizing the chart in the setup wizard. Callers turn this into a
 * 409 so the underlying business event (payment, purchase receipt, waste
 * entry) rolls back cleanly instead of silently posting an incomplete entry.
 */
export class MissingLedgerAccountError extends Error {
  code: string;
  constructor(code: string) {
    super(`ledger_account_missing: ${code}`);
    this.code = code;
  }
}

export async function accountIdsByCode(
  client: PoolClient,
  businessId: string,
  codes: string[],
): Promise<Map<string, string>> {
  const uniqueCodes = [...new Set(codes)];
  const { rows } = await client.query<{ code: string; id: string }>(
    "SELECT code, id FROM accounts WHERE business_id = $1 AND code = ANY($2::text[]) AND is_active",
    [businessId, uniqueCodes],
  );
  const map = new Map(rows.map((r) => [r.code, r.id]));
  for (const code of uniqueCodes) {
    if (!map.has(code)) throw new MissingLedgerAccountError(code);
  }
  return map;
}

export interface ExactJournalLine {
  accountId: string;
  debit: RialText;
  credit: RialText;
}

/**
 * Exported (Phase 21 Wave 1) so posting-engine.ts's dispatchDomainEvent can
 * post a registered rule's lines through the same exact-arithmetic path
 * every inventory-costing-sensitive posting already uses — RialText/BigInt,
 * not the plain-number postJournalEntry, since Wave 2's weight-based gold
 * pricing will need the same precision guarantee this already gives
 * COGS/purchases/waste.
 */
export async function postExactJournalEntry(
  client: PoolClient,
  input: Omit<PostJournalEntryInput, "lines"> & { lines: ExactJournalLine[] },
): Promise<string | null> {
  const lines = input.lines.filter((line) => rialBigInt(line.debit) !== 0n || rialBigInt(line.credit) !== 0n);
  if (lines.length === 0) return null;
  let debit = 0n;
  let credit = 0n;
  for (const line of lines) {
    const lineDebit = rialBigInt(line.debit);
    const lineCredit = rialBigInt(line.credit);
    if (!line.accountId || lineDebit < 0n || lineCredit < 0n || (lineDebit !== 0n && lineCredit !== 0n)) {
      throw new Error("invalid_exact_journal_line");
    }
    debit += lineDebit;
    credit += lineCredit;
  }
  if (debit !== credit) throw new Error("unbalanced_journal_entry");

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries
       (business_id,location_id,entry_date,memo,source_type,source_id,created_by,posting_kind,inventory_event_id)
     VALUES($1,$2,COALESCE($3,CURRENT_DATE),$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      input.businessId,
      input.locationId,
      input.entryDate ?? null,
      input.memo,
      input.sourceType,
      input.sourceId,
      input.createdBy,
      input.postingKind ?? null,
      input.inventoryEventId ?? null,
    ],
  );
  for (const line of lines) {
    await client.query(
      "INSERT INTO journal_lines(entry_id,account_id,debit,credit) VALUES($1,$2,$3,$4)",
      [rows[0].id, line.accountId, line.debit, line.credit],
    );
  }
  return rows[0].id;
}

export async function postExactPurchaseEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    purchaseId: string;
    createdBy: string | null;
    total: RialText;
    settlementMethod: SettlementMethod;
    inventoryEventId: string;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.inventory,
    WELL_KNOWN_CODES.accountsPayable,
    WELL_KNOWN_CODES.cash,
    WELL_KNOWN_CODES.bankClearing,
  ]);
  const creditCode =
    params.settlementMethod === "cash"
      ? WELL_KNOWN_CODES.cash
      : params.settlementMethod === "bank"
        ? WELL_KNOWN_CODES.bankClearing
        : WELL_KNOWN_CODES.accountsPayable;
  return postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: "Purchase receipt",
    sourceType: "purchase",
    sourceId: params.purchaseId,
    createdBy: params.createdBy,
    postingKind: "receipt",
    inventoryEventId: params.inventoryEventId,
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.inventory)!, debit: params.total, credit: "0" as RialText },
      { accountId: accounts.get(creditCode)!, debit: "0" as RialText, credit: params.total },
    ],
  });
}

/**
 * Corrects provisional COGS to the value actually assigned when an incoming
 * quantity closes a negative layer. Shared by purchase receipts and by
 * stock-count surpluses, which settle layers on the same terms.
 */
export async function postExactNegativeSettlementEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    sourceType: string;
    sourceId: string;
    createdBy: string | null;
    upward: RialText;
    downward: RialText;
    inventoryEventId: string;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.inventory,
    WELL_KNOWN_CODES.cogs,
  ]);
  const zero = "0" as RialText;
  return postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: "Negative stock cost settlement",
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    createdBy: params.createdBy,
    postingKind: "negative_stock_settlement",
    inventoryEventId: params.inventoryEventId,
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.cogs)!, debit: params.upward, credit: zero },
      { accountId: accounts.get(WELL_KNOWN_CODES.inventory)!, debit: zero, credit: params.upward },
      { accountId: accounts.get(WELL_KNOWN_CODES.inventory)!, debit: params.downward, credit: zero },
      { accountId: accounts.get(WELL_KNOWN_CODES.cogs)!, debit: zero, credit: params.downward },
    ],
  });
}

export async function postNegativeStockSettlementEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    purchaseId: string;
    createdBy: string | null;
    upward: RialText;
    downward: RialText;
    inventoryEventId: string;
  },
): Promise<string | null> {
  return postExactNegativeSettlementEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    sourceType: "purchase",
    sourceId: params.purchaseId,
    createdBy: params.createdBy,
    upward: params.upward,
    downward: params.downward,
    inventoryEventId: params.inventoryEventId,
  });
}

/** Stock-count variance → shortage to count expense, surplus to count gain. */
export async function postExactStockCountEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    stockCountId: string;
    inventoryEventId: string;
    createdBy: string | null;
    shortageValue: RialText;
    surplusValue: RialText;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.inventory,
    WELL_KNOWN_CODES.inventoryCountExpense,
    WELL_KNOWN_CODES.inventoryCountGain,
  ]);
  const inventory = accounts.get(WELL_KNOWN_CODES.inventory)!;
  const zero = "0" as RialText;
  return postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: "مغایرت شمارش موجودی",
    sourceType: "stock_count",
    sourceId: params.stockCountId,
    createdBy: params.createdBy,
    postingKind: "variance",
    inventoryEventId: params.inventoryEventId,
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.inventoryCountExpense)!, debit: params.shortageValue, credit: zero },
      { accountId: inventory, debit: zero, credit: params.shortageValue },
      { accountId: inventory, debit: params.surplusValue, credit: zero },
      { accountId: accounts.get(WELL_KNOWN_CODES.inventoryCountGain)!, debit: zero, credit: params.surplusValue },
    ],
  });
}

export async function postExactCogsEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    orderId: string;
    createdBy: string | null;
    totalCost: RialText;
    inventoryEventId: string;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.inventory,
    WELL_KNOWN_CODES.cogs,
  ]);
  const zero = "0" as RialText;
  return postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: "Cost of goods sold",
    sourceType: "order",
    sourceId: params.orderId,
    createdBy: params.createdBy,
    postingKind: "cogs",
    inventoryEventId: params.inventoryEventId,
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.cogs)!, debit: params.totalCost, credit: zero },
      { accountId: accounts.get(WELL_KNOWN_CODES.inventory)!, debit: zero, credit: params.totalCost },
    ],
  });
}

export async function postExactOrderPaymentEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    orderId: string;
    createdBy: string | null;
    method: string;
    amount: RialText;
    tax: RialText;
    inventoryEventId: string;
    orderChannel: OrderChannel;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.cash,
    WELL_KNOWN_CODES.bankClearing,
    WELL_KNOWN_CODES.accountsReceivable,
    WELL_KNOWN_CODES.dineInRevenue,
    WELL_KNOWN_CODES.takeawayRevenue,
    WELL_KNOWN_CODES.deliveryRevenue,
    WELL_KNOWN_CODES.vatPayable,
  ]);
  const debitCode =
    params.method === "cash"
      ? WELL_KNOWN_CODES.cash
      : params.method === "credit"
        ? WELL_KNOWN_CODES.accountsReceivable
        : WELL_KNOWN_CODES.bankClearing;
  if (!["cash", "card", "card_to_card", "online", "credit"].includes(params.method)) {
    throw new Error(`unknown_payment_method: ${params.method}`);
  }
  const revenue = rialBigInt(params.amount) - rialBigInt(params.tax);
  if (revenue < 0n) throw new Error("tax_exceeds_payment");
  const revenueCode = revenueAccountCodeForOrderChannel(params.orderChannel, {
    dineInRevenue: WELL_KNOWN_CODES.dineInRevenue,
    takeawayRevenue: WELL_KNOWN_CODES.takeawayRevenue,
    deliveryRevenue: WELL_KNOWN_CODES.deliveryRevenue,
  });
  const zero = "0" as RialText;
  return postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: "Order payment",
    sourceType: "order",
    sourceId: params.orderId,
    createdBy: params.createdBy,
    postingKind: "revenue",
    inventoryEventId: params.inventoryEventId,
    lines: [
      { accountId: accounts.get(debitCode)!, debit: params.amount, credit: zero },
      {
        accountId: accounts.get(revenueCode)!,
        debit: zero,
        credit: revenue.toString() as RialText,
      },
      { accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: zero, credit: params.tax },
    ],
  });
}

export async function postExactOperationalInventoryEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    sourceType: string;
    sourceId: string;
    postingKind: string;
    memo: string;
    createdBy: string | null;
    inventoryEventId: string;
    debitCode: string;
    creditCode: string;
    amount: RialText;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [params.debitCode, params.creditCode]);
  const zero = "0" as RialText;
  return postExactJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: params.memo,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    createdBy: params.createdBy,
    postingKind: params.postingKind,
    inventoryEventId: params.inventoryEventId,
    lines: [
      { accountId: accounts.get(params.debitCode)!, debit: params.amount, credit: zero },
      { accountId: accounts.get(params.creditCode)!, debit: zero, credit: params.amount },
    ],
  });
}

export async function postExactCustomerRefundEntry(
  client: PoolClient,
  params: {
    businessId:string; locationId:string; customerReturnId:string; createdBy:string;
    inventoryEventId:string; paymentMethod:string; amount:RialText; tax:RialText;
  },
): Promise<string|null> {
  const accounts=await accountIdsByCode(client,params.businessId,[
    WELL_KNOWN_CODES.cash,WELL_KNOWN_CODES.bankClearing,WELL_KNOWN_CODES.accountsReceivable,
    WELL_KNOWN_CODES.salesReturns,WELL_KNOWN_CODES.vatPayable,
  ]);
  const refundAccount=params.paymentMethod==="cash"?WELL_KNOWN_CODES.cash:
    params.paymentMethod==="credit"?WELL_KNOWN_CODES.accountsReceivable:WELL_KNOWN_CODES.bankClearing;
  const net=rialBigInt(params.amount)-rialBigInt(params.tax);
  if(net<0n)throw new Error("tax_exceeds_refund");
  const zero="0" as RialText;
  return postExactJournalEntry(client,{businessId:params.businessId,locationId:params.locationId,
    memo:"Customer refund",sourceType:"customer_return",sourceId:params.customerReturnId,
    createdBy:params.createdBy,postingKind:"customer_refund",inventoryEventId:params.inventoryEventId,
    lines:[
      {accountId:accounts.get(WELL_KNOWN_CODES.salesReturns)!,debit:net.toString() as RialText,credit:zero},
      {accountId:accounts.get(WELL_KNOWN_CODES.vatPayable)!,debit:params.tax,credit:zero},
      {accountId:accounts.get(refundAccount)!,debit:zero,credit:params.amount},
    ]});
}

export interface PostJournalEntryInput {
  businessId: string;
  locationId: string | null;
  /** ISO date (YYYY-MM-DD); defaults to today */
  entryDate?: string | null;
  memo: string | null;
  sourceType: string;
  sourceId: string | null;
  lines: JournalLine[];
  createdBy: string | null;
  postingKind?: string | null;
  inventoryEventId?: string | null;
}

/**
 * Inserts a journal_entries row + its journal_lines, after validating the
 * lines balance. Lines with debit=credit=0 are dropped first; if nothing is
 * left, no entry is created (e.g. a zero-cost waste/COGS event) and null is
 * returned.
 */
export async function postJournalEntry(client: PoolClient, input: PostJournalEntryInput): Promise<string | null> {
  const lines = input.lines.filter((l) => l.debit !== 0 || l.credit !== 0);
  if (lines.length === 0) return null;

  const errors = validateJournalLines(lines);
  if (errors.length > 0) {
    throw new Error(`unbalanced_journal_entry: ${errors.join("; ")}`);
  }
  if (!checkBalance(lines).balanced) {
    throw new Error("unbalanced_journal_entry");
  }

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, source_id, created_by, posting_kind, inventory_event_id)
     VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, $5, $6, $7, $8, $9) RETURNING id`,
    [input.businessId, input.locationId, input.entryDate ?? null, input.memo, input.sourceType, input.sourceId, input.createdBy, input.postingKind ?? null, input.inventoryEventId ?? null],
  );
  const entryId = rows[0].id;
  for (const l of lines) {
    await client.query("INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, $4)", [
      entryId,
      l.accountId,
      l.debit,
      l.credit,
    ]);
  }
  return entryId;
}

/** Order paid → Debit Cash/Bank-Clearing/Accounts-Receivable / Credit Sales Revenue + Tax Payable. */
export async function postOrderPaymentEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    orderId: string;
    createdBy: string | null;
    method: string;
    amount: Rial;
    tax: Rial;
    inventoryEventId?: string | null;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.cash,
    WELL_KNOWN_CODES.bankClearing,
    WELL_KNOWN_CODES.accountsReceivable,
    WELL_KNOWN_CODES.salesRevenue,
    WELL_KNOWN_CODES.vatPayable,
  ]);
  const lines = buildOrderPaymentLines(
    {
      cash: accounts.get(WELL_KNOWN_CODES.cash)!,
      bankClearing: accounts.get(WELL_KNOWN_CODES.bankClearing)!,
      accountsReceivable: accounts.get(WELL_KNOWN_CODES.accountsReceivable)!,
      salesRevenue: accounts.get(WELL_KNOWN_CODES.salesRevenue)!,
      vatPayable: accounts.get(WELL_KNOWN_CODES.vatPayable)!,
    },
    { method: params.method, amount: params.amount, tax: params.tax },
  );
  return postJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: "فروش سفارش",
    sourceType: "order",
    sourceId: params.orderId,
    lines,
    createdBy: params.createdBy,
    postingKind: "revenue",
    inventoryEventId: params.inventoryEventId,
  });
}

/** Stock deducted on sale → Debit COGS / Credit Inventory Asset. */
export async function postCogsEntry(
  client: PoolClient,
  params: { businessId: string; locationId: string; orderId: string; createdBy: string | null; totalCost: Rial; inventoryEventId?: string | null },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [WELL_KNOWN_CODES.cogs, WELL_KNOWN_CODES.inventory]);
  const lines = buildCogsLines(
    { cogs: accounts.get(WELL_KNOWN_CODES.cogs)!, inventory: accounts.get(WELL_KNOWN_CODES.inventory)! },
    params.totalCost,
  );
  return postJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: "بهای تمام‌شده کالای فروش‌رفته",
    sourceType: "order",
    sourceId: params.orderId,
    lines,
    createdBy: params.createdBy,
    postingKind: "cogs",
    inventoryEventId: params.inventoryEventId,
  });
}

/** Waste logged → Debit Waste Expense / Credit Inventory Asset. */
export async function postWasteEntry(
  client: PoolClient,
  params: { businessId: string; locationId: string; sourceId: string; createdBy: string | null; totalCost: Rial; inventoryEventId?: string },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.wasteExpense,
    WELL_KNOWN_CODES.inventory,
  ]);
  const lines = buildWasteLines(
    { wasteExpense: accounts.get(WELL_KNOWN_CODES.wasteExpense)!, inventory: accounts.get(WELL_KNOWN_CODES.inventory)! },
    params.totalCost,
  );
  return postJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: "ضایعات",
    sourceType: "waste",
    sourceId: params.sourceId,
    lines,
    createdBy: params.createdBy,
    postingKind: "waste",
    inventoryEventId: params.inventoryEventId,
  });
}

/** Purchase received → Debit Inventory Asset / Credit Accounts Payable (or Cash/Bank). */
export async function postPurchaseEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    purchaseId: string;
    createdBy: string | null;
    total: Rial;
    settlementMethod: SettlementMethod;
    inventoryEventId?: string | null;
  },
): Promise<string | null> {
  const accounts = await accountIdsByCode(client, params.businessId, [
    WELL_KNOWN_CODES.inventory,
    WELL_KNOWN_CODES.accountsPayable,
    WELL_KNOWN_CODES.cash,
    WELL_KNOWN_CODES.bankClearing,
  ]);
  const lines = buildPurchaseLines(
    {
      inventory: accounts.get(WELL_KNOWN_CODES.inventory)!,
      accountsPayable: accounts.get(WELL_KNOWN_CODES.accountsPayable)!,
      cash: accounts.get(WELL_KNOWN_CODES.cash)!,
      bankClearing: accounts.get(WELL_KNOWN_CODES.bankClearing)!,
    },
    { total: params.total, settlementMethod: params.settlementMethod },
  );
  return postJournalEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    memo: "دریافت کالای خرید",
    sourceType: "purchase",
    sourceId: params.purchaseId,
    lines,
    createdBy: params.createdBy,
    postingKind: "receipt",
    inventoryEventId: params.inventoryEventId,
  });
}

/** Physical count variance: shortage is expense; surplus is count gain. */
export async function postStockCountEntry(client: PoolClient, params: {
  businessId: string; locationId: string; stockCountId: string; inventoryEventId: string;
  createdBy: string | null; shortageValue: Rial; surplusValue: Rial;
}): Promise<string | null> {
  const codes = [WELL_KNOWN_CODES.inventory, WELL_KNOWN_CODES.inventoryCountExpense, WELL_KNOWN_CODES.inventoryCountGain];
  const accounts = await accountIdsByCode(client, params.businessId, codes);
  const inventory = accounts.get(WELL_KNOWN_CODES.inventory)!;
  const lines = [
    { accountId: accounts.get(WELL_KNOWN_CODES.inventoryCountExpense)!, debit: params.shortageValue, credit: 0 },
    { accountId: inventory, debit: 0, credit: params.shortageValue },
    { accountId: inventory, debit: params.surplusValue, credit: 0 },
    { accountId: accounts.get(WELL_KNOWN_CODES.inventoryCountGain)!, debit: 0, credit: params.surplusValue },
  ];
  return postJournalEntry(client, { businessId: params.businessId, locationId: params.locationId,
    memo: "مغایرت شمارش موجودی", sourceType: "stock_count", sourceId: params.stockCountId,
    postingKind: "variance", inventoryEventId: params.inventoryEventId, lines, createdBy: params.createdBy });
}
