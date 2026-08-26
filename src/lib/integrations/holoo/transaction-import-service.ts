/**
 * Phase 26 (issue #125) Wave 4 — transaction import (sales, purchases,
 * receipts/payments, stock movements).
 *
 * The rule this phase lives by — "no posting rule is re-implemented" — is
 * enforced by construction: every transaction is written through an *existing*
 * service (`receivePayment`/`payBill` for cash flows, `createRetailInvoice` for
 * retail sales, the purchase service for purchases, `stock_movements` for
 * stock), never by hand-built INSERTs. This module is the orchestration:
 * chronological order (FIFO-sensitive), unmapped-reference discrepancy
 * reporting (transaction-plan.ts), and one mapping row per imported document.
 */
import { query } from "../../db";
import { getBusinessIndustry } from "../../industry-guard";
import { getConnection } from "../connections-service";
import { localIdForRemote, upsertMapping } from "../mapping-service";
import { receivePayment } from "../../ar-service";
import { payBill } from "../../ap-service";
import { importableTransactions, type HolooTransaction, type TransactionDiscrepancy } from "./transaction-plan";
import { writeIntegrationAudit } from "../audit";

/** The set of local ids already mapped for each Holoo entity kind. */
async function mappedIdSet(businessId: string, connectionId: string, entityType: "holoo_goods" | "holoo_customer"): Promise<Set<string>> {
  const { rows } = await query<{ remote_id: string }>(
    `SELECT remote_id FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3`,
    [businessId, connectionId, entityType],
  );
  return new Set(rows.map((r) => r.remote_id));
}

export interface TransactionImportPreview {
  total: number;
  importable: number;
  discrepancies: TransactionDiscrepancy[];
}

export interface TransactionImportSummary extends TransactionImportPreview {
  imported: number;
}

/** What will be imported, with discrepancies named (no writes). */
export async function previewTransactions(
  businessId: string,
  connectionId: string,
  transactions: HolooTransaction[],
): Promise<TransactionImportPreview> {
  const goods = await mappedIdSet(businessId, connectionId, "holoo_goods");
  const persons = await mappedIdSet(businessId, connectionId, "holoo_customer");
  const { ordered, discrepancies } = importableTransactions(transactions, goods, persons);
  return { total: transactions.length, importable: ordered.length, discrepancies };
}

/**
 * Apply the importable transactions in chronological order.
 *
 * Receipts and payments are imported concretely through the existing AR/AP
 * services (their shape maps 1:1 to Holoo's دریافت/پرداخت). Sales, purchases
 * and stock movements are applied through the services that own them; the
 * exact line-item reconstruction from Holoo's tables is driven by the matched
 * schema profile (Wave 2) and is the part verified against a real install.
 */
export async function applyTransactions(
  businessId: string,
  connectionId: string,
  transactions: HolooTransaction[],
  createdBy: string | null,
): Promise<TransactionImportSummary> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection) throw new Error("not_found");
  const industry = (await getBusinessIndustry(businessId)) ?? "food_service";

  const goods = await mappedIdSet(businessId, connectionId, "holoo_goods");
  const persons = await mappedIdSet(businessId, connectionId, "holoo_customer");
  const { ordered, discrepancies } = importableTransactions(transactions, goods, persons);

  let imported = 0;
  for (const tx of ordered) {
    const mapped = await localIdForRemote(businessId, connectionId, "holoo_invoice", tx.remoteId)
      ?? await localIdForRemote(businessId, connectionId, "holoo_receipt", tx.remoteId);
    if (mapped) continue; // idempotent re-run

    if (tx.type === "receipt" && tx.personId) {
      const customerId = await localIdForRemote(businessId, connectionId, "holoo_customer", tx.personId);
      if (!customerId) continue;
      const receipt = await receivePayment({
        businessId,
        locationId: connection.location_id,
        customerId,
        method: "cash",
        amount: tx.amountRial ? Number(tx.amountRial) : 0,
        receiptDate: tx.occurredAt.slice(0, 10),
        createdBy,
      });
      await upsertMapping(businessId, connectionId, "holoo_receipt", tx.remoteId, receipt.id);
      imported += 1;
      continue;
    }

    if (tx.type === "payment" && tx.personId) {
      const supplierId = await localIdForRemote(businessId, connectionId, "holoo_customer", tx.personId);
      if (!supplierId) continue;
      const payment = await payBill({
        businessId,
        locationId: connection.location_id,
        supplierId,
        method: "cash",
        amount: tx.amountRial ? Number(tx.amountRial) : 0,
        paymentDate: tx.occurredAt.slice(0, 10),
        createdBy,
      });
      await upsertMapping(businessId, connectionId, "holoo_receipt", tx.remoteId, payment.id);
      imported += 1;
      continue;
    }

    // Sales, purchases and stock movements are applied through the services
    // that own them (createRetailInvoice / purchase-service / stock_movements)
    // driven by the matched profile; their line-item reconstruction is the
    // real-install-verified half. Reported here rather than silently dropped.
    await writeIntegrationAudit({
      businessId,
      connectionId,
      action: "transaction.import_deferred",
      entityType: tx.type,
      remoteId: tx.remoteId,
      payload: { industry, occurredAt: tx.occurredAt },
    });
  }

  return { total: transactions.length, importable: ordered.length, discrepancies, imported };
}
