/**
 * The bridge from a won deal to a real sales document.
 *
 * ## The thing this deliberately does NOT do
 *
 * It does not post revenue. Moving a deal to «برنده» writes no journal line,
 * no invoice and no order, and neither does this module.
 *
 * That restraint is the whole design, and it is worth being explicit about
 * why, because "won deal → book the revenue" sounds like exactly what a CRM
 * should do:
 *
 * 1. **It would let anyone with CRM access fabricate revenue.** Dragging a
 *    card between two columns is a low-ceremony gesture performed by
 *    salespeople on phones. Issuing a financial document is a deliberate act
 *    with tax consequences. Wiring the first to the second means the income
 *    statement can be moved by a mis-drag.
 * 2. **It would double-count.** The real invoice gets raised in Accounting
 *    regardless — that is where stock, pricing, tax and payment terms live. A
 *    deal that also posted would book the same sale twice.
 * 3. **A deal's value is a forecast, not a price.** «۵۰ میلیون» on a deal card
 *    is somebody's estimate. An invoice line has a quantity, a unit price, a
 *    tax treatment and an item that must exist in the catalogue. Silently
 *    converting the first into the second invents four facts nobody supplied.
 *
 * ## What it does instead
 *
 * It prepares a **handoff**: a validated, pre-filled intent that a human
 * completes in the Accounting app, where sales documents belong. The CRM
 * records that the handoff happened and links the resulting document back to
 * the deal, so «این معامله به کدام فاکتور رسید؟» has an answer — which is the
 * genuinely useful half of the integration, and the half that does not require
 * the CRM to be able to post.
 */

import { query } from "./db";
import { recordCrmAudit } from "./crm-audit-service";
import { isUuid } from "./uuid";

export interface DealHandoff {
  dealId: string;
  dealTitle: string;
  customerId: string;
  customerName: string;
  /** The forecast value, carried across as a *suggestion* only. */
  suggestedValueRial: number;
  /** Where the user is sent to complete the sale. */
  href: string;
  /** Anything that makes this deal not ready to become a sale. */
  blockers: HandoffBlocker[];
}

export interface HandoffBlocker {
  code: "no_customer" | "not_won" | "already_linked" | "customer_archived";
  message: string;
}

/**
 * Check whether a deal can become a sales document, and prepare the handoff.
 *
 * Read-only. It answers "is this ready, and where does the user go next?" —
 * nothing is written until `linkDealToSalesDocument` records the outcome.
 *
 * The blockers are returned as a list rather than as a thrown error because
 * the UI shows them all at once: telling somebody their deal has no customer,
 * then after they fix it that it is not won, is two round trips to learn one
 * thing.
 */
export async function prepareDealHandoff(
  businessId: string,
  dealId: string,
): Promise<DealHandoff | null> {
  if (!isUuid(dealId)) return null;

  const { rows } = await query<{
    id: string;
    title: string;
    value_rial: string;
    order_id: string | null;
    customer_id: string | null;
    customer_name: string | null;
    customer_active: boolean | null;
    customer_merged: string | null;
    stage_outcome: string | null;
  }>(
    `SELECT d.id, d.title, d.value_rial, d.order_id,
            d.customer_id, c.name AS customer_name,
            c.is_active AS customer_active, c.merged_into_id AS customer_merged,
            st.outcome AS stage_outcome
       FROM crm_deals d
       LEFT JOIN parties c ON c.id = d.customer_id
       LEFT JOIN crm_pipeline_stages st ON st.id = d.stage_id
      WHERE d.business_id = $1 AND d.id = $2`,
    [businessId, dealId],
  );
  const deal = rows[0];
  if (!deal) return null;

  const blockers: HandoffBlocker[] = [];
  if (!deal.customer_id) {
    blockers.push({
      code: "no_customer",
      message: "این معامله به هیچ مشتری وصل نیست. فاکتور بدون مشتری صادر نمی‌شود.",
    });
  } else if (deal.customer_merged || deal.customer_active === false) {
    // A merged-away customer is archived, not deleted; invoicing it would
    // attach a sale to a record no screen shows.
    blockers.push({
      code: "customer_archived",
      message: "پروندهٔ این مشتری بایگانی شده است. ابتدا معامله را به پروندهٔ فعال منتقل کنید.",
    });
  }
  if (deal.stage_outcome !== "won") {
    blockers.push({
      code: "not_won",
      message: "فقط معامله‌ای که برنده شده است به فاکتور تبدیل می‌شود.",
    });
  }
  if (deal.order_id) {
    blockers.push({
      code: "already_linked",
      message: "برای این معامله قبلاً سند فروش ثبت شده است.",
    });
  }

  return {
    dealId: deal.id,
    dealTitle: deal.title,
    customerId: deal.customer_id ?? "",
    customerName: deal.customer_name ?? "",
    // Explicitly "suggested". The Accounting screen pre-fills it and the user
    // enters the real lines; nothing here decides what the sale is worth.
    suggestedValueRial: Number(deal.value_rial ?? 0),
    // Deep link into Accounting with the deal carried along, so the document
    // created there can be linked back without the user copying an id.
    href: `/accounting/invoices/new?customer=${deal.customer_id ?? ""}&deal=${deal.id}`,
    blockers,
  };
}

/**
 * Record that a deal became a particular sales document.
 *
 * Called *after* Accounting has created the order/invoice — this is the CRM
 * recording an outcome, not causing one. The distinction matters: if this
 * function created the document, every caveat in the file comment would apply
 * to it.
 *
 * The order is verified to belong to this business before it is linked. The
 * id arrives from a browser, and a link to another tenant's order would leak
 * that order's number and total onto this deal's card.
 */
export async function linkDealToSalesDocument(
  businessId: string,
  dealId: string,
  orderId: string,
  actor: { name: string; userId?: string | null },
): Promise<{ ok: boolean; error?: "not_found" | "order_not_found" | "already_linked" }> {
  if (!isUuid(dealId) || !isUuid(orderId)) return { ok: false, error: "not_found" };

  const { rows: dealRows } = await query<{ id: string; title: string; order_id: string | null; customer_id: string | null }>(
    `SELECT id, title, order_id, customer_id FROM crm_deals WHERE business_id = $1 AND id = $2`,
    [businessId, dealId],
  );
  const deal = dealRows[0];
  if (!deal) return { ok: false, error: "not_found" };
  // Idempotent rather than an error when it is the *same* document: a retried
  // request must not fail after the first one succeeded.
  if (deal.order_id === orderId) return { ok: true };
  if (deal.order_id) return { ok: false, error: "already_linked" };

  // Tenancy proven through the order's branch, because `orders` is
  // location-scoped and carries no business_id of its own.
  const { rows: orderRows } = await query<{ id: string; order_number: number | null }>(
    `SELECT o.id, o.order_number
       FROM orders o
       JOIN locations l ON l.id = o.location_id
      WHERE l.business_id = $1 AND o.id = $2`,
    [businessId, orderId],
  );
  if (!orderRows[0]) return { ok: false, error: "order_not_found" };

  await query(
    `UPDATE crm_deals SET order_id = $3, last_activity_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, dealId, orderId],
  );

  await recordCrmAudit({
    businessId,
    kind: "deal.sales_document_linked",
    entityType: "deal",
    entityId: dealId,
    partyId: deal.customer_id,
    summary: `«${deal.title}» به سند فروش وصل شد`,
    detail: {
      orderId,
      orderNumber: orderRows[0].order_number,
      // Recorded so an auditor reading the trail can see the CRM observed the
      // document rather than created it.
      createdByCrm: false,
    },
    actorUserId: actor.userId ?? null,
    actorName: actor.name,
  });

  return { ok: true };
}
