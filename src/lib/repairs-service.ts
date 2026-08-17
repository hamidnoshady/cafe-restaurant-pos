/**
 * Phase 21 Wave 5 — the repair/service ticket workflow: پذیرش (intake) →
 * مصرف قطعات (parts) → اجرت (labor) → بستن (close, which posts).
 *
 * Settles Phase 21's open question 5 (ticket statuses, and whether this
 * reuses the kitchen-ticket state machine): it does not — see
 * `validateRepairStatusTransition`'s doc comment in watch.ts for why. A
 * kitchen ticket lives for minutes and is never billed; a repair ticket
 * lives for days, accrues parts and labor, and posts to the ledger when it
 * closes.
 *
 * Closing is the only status change that goes through its own function
 * rather than `setRepairStatus`, because closing is when the ticket
 * becomes an accounting fact: it posts a revenue entry (unless the job was
 * under warranty and billed nothing) and a parts-cost entry (even when it
 * *was* under warranty — the shop still consumed parts that cost money).
 *
 * DB-touching, so per repo convention it has no direct unit test; covered
 * instead by integration/repairs.integration.test.ts.
 */
import { getPool, query, type PoolClient } from "./db";
import {
  isWarrantyActive,
  validateRepairPart,
  validateRepairStatusTransition,
  type RepairPartInput,
  type RepairStatus,
} from "./watch";
import { computeRepairCharge, type RepairChargeBreakdown } from "./watch-pricing";
import { getSerialWarranty } from "./watch-sales-service";
import { emitDomainEvent } from "./posting-engine";
import type { SettlementMethod } from "./ledger";
// Side-effect import: registers the watch.* posting rules with the engine.
import "./watch-posting-rules";

export interface RepairTicket {
  id: string;
  locationId: string;
  ticketNumber: number;
  customerId: string | null;
  serialId: string | null;
  itemDescription: string;
  reportedIssue: string | null;
  status: RepairStatus;
  underWarranty: boolean;
  laborCharge: number;
  vatPercent: number;
  /** Phase 27 Wave 10 — the estimate the customer must approve before work starts. */
  estimatedTotalRial: number;
  estimatedLaborRial: number;
  estimatedPartsRial: number;
  estimatedAt: string | null;
  estimateApprovedAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface RepairPart {
  id: string;
  ticketId: string;
  itemId: string | null;
  description: string;
  quantity: string;
  unitCost: number;
  charge: number;
}

interface TicketRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  ticket_number: string;
  customer_id: string | null;
  serial_id: string | null;
  item_description: string;
  reported_issue: string | null;
  status: RepairStatus;
  under_warranty: boolean;
  labor_charge: string;
  vat_percent: string;
  estimated_total_rial: string;
  estimated_labor_rial: string;
  estimated_parts_rial: string;
  estimated_at: string | null;
  estimate_approved_at: string | null;
  closed_at: string | null;
  created_at: string;
}

function mapTicket(row: TicketRow): RepairTicket {
  return {
    id: row.id,
    locationId: row.location_id,
    ticketNumber: Number(row.ticket_number),
    customerId: row.customer_id,
    serialId: row.serial_id,
    itemDescription: row.item_description,
    reportedIssue: row.reported_issue,
    status: row.status,
    underWarranty: row.under_warranty,
    laborCharge: Number(row.labor_charge),
    vatPercent: Number(row.vat_percent),
    estimatedTotalRial: Number(row.estimated_total_rial),
    estimatedLaborRial: Number(row.estimated_labor_rial),
    estimatedPartsRial: Number(row.estimated_parts_rial),
    estimatedAt: row.estimated_at,
    estimateApprovedAt: row.estimate_approved_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

interface PartRow extends Record<string, unknown> {
  id: string;
  ticket_id: string;
  item_id: string | null;
  description: string;
  quantity: string;
  unit_cost: string;
  charge: string;
}

function mapPart(row: PartRow): RepairPart {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    itemId: row.item_id,
    description: row.description,
    quantity: row.quantity,
    unitCost: Number(row.unit_cost),
    charge: Number(row.charge),
  };
}

export interface CreateRepairTicketInput {
  locationId: string;
  itemDescription: string;
  reportedIssue?: string | null;
  customerId?: string | null;
  /** Optional link to a unit the shop itself tracks — what makes the warranty check below possible. */
  serialId?: string | null;
  laborCharge?: number;
  vatPercent?: number;
  createdBy?: string | null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Takes a piece in. Whether the job is under warranty is resolved here,
 * once, from the linked unit's live window — not re-derived at close, since
 * the window can expire between intake and close and what governs the bill
 * is the state on the day the shop accepted the piece.
 */
export async function createRepairTicket(input: CreateRepairTicketInput): Promise<RepairTicket> {
  const description = input.itemDescription?.trim();
  if (!description) throw new Error("شرح کالای تعمیری نمی‌تواند خالی باشد.");

  const laborCharge = input.laborCharge ?? 0;
  if (!Number.isInteger(laborCharge) || laborCharge < 0) {
    throw new Error("اجرت تعمیر باید یک عدد صحیح غیرمنفی (ریال) باشد.");
  }
  const vatPercent = input.vatPercent ?? 0;
  if (!Number.isFinite(vatPercent) || vatPercent < 0 || vatPercent > 100) {
    throw new Error("درصد مالیات باید بین ۰ تا ۱۰۰ باشد.");
  }

  let underWarranty = false;
  if (input.serialId) {
    underWarranty = isWarrantyActive(await getSerialWarranty(input.serialId), todayIso());
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Same atomic UPDATE ... RETURNING counter Phase 2 uses for order
    // numbers, for the same reason: two people at the counter must never
    // hand out the same ticket number.
    const { rows: counter } = await client.query<{ next_number: string }>(
      `INSERT INTO repair_ticket_counters (location_id, next_number) VALUES ($1, 2)
       ON CONFLICT (location_id) DO UPDATE SET next_number = repair_ticket_counters.next_number + 1
       RETURNING next_number`,
      [input.locationId],
    );
    const ticketNumber = Number(counter[0].next_number) - 1;

    const { rows } = await client.query<TicketRow>(
      `INSERT INTO repair_tickets
         (location_id, ticket_number, customer_id, serial_id, item_description, reported_issue,
          under_warranty, labor_charge, vat_percent, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        input.locationId,
        ticketNumber,
        input.customerId ?? null,
        input.serialId ?? null,
        description,
        input.reportedIssue?.trim() || null,
        underWarranty,
        laborCharge,
        vatPercent,
        input.createdBy ?? null,
      ],
    );

    // A unit that's in the shop for repair is not on the shelf. Skipped for
    // an already-sold unit, whose `sold` status is terminal by Wave 1's own
    // rule and must not be walked back by a service visit.
    if (input.serialId) {
      await client.query(
        `UPDATE item_serials SET status = 'in_repair' WHERE id = $1 AND status = 'in_stock'`,
        [input.serialId],
      );
    }

    await client.query("COMMIT");
    return mapTicket(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listRepairTickets(
  locationId: string,
  options: { status?: RepairStatus } = {},
): Promise<RepairTicket[]> {
  const { rows } = await query<TicketRow>(
    `SELECT * FROM repair_tickets
      WHERE location_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY ticket_number DESC`,
    [locationId, options.status ?? null],
  );
  return rows.map(mapTicket);
}

export async function getRepairTicket(id: string): Promise<RepairTicket | null> {
  const { rows } = await query<TicketRow>(`SELECT * FROM repair_tickets WHERE id = $1`, [id]);
  return rows[0] ? mapTicket(rows[0]) : null;
}

/** Every repair this specific unit has been through — the "repair history queryable from one item record" half of Wave 5's exit criterion. */
export async function listRepairsForSerial(serialId: string): Promise<RepairTicket[]> {
  const { rows } = await query<TicketRow>(
    `SELECT * FROM repair_tickets WHERE serial_id = $1 ORDER BY ticket_number DESC`,
    [serialId],
  );
  return rows.map(mapTicket);
}

export async function listRepairParts(ticketId: string): Promise<RepairPart[]> {
  const { rows } = await query<PartRow>(
    `SELECT * FROM repair_ticket_parts WHERE ticket_id = $1 ORDER BY created_at`,
    [ticketId],
  );
  return rows.map(mapPart);
}

function assertOpen(ticket: RepairTicket): void {
  if (ticket.status === "closed" || ticket.status === "cancelled") {
    throw new Error("تیکت بسته‌شده یا لغوشده را نمی‌توان تغییر داد.");
  }
}

export async function addRepairPart(
  ticketId: string,
  input: RepairPartInput & { itemId?: string | null },
): Promise<RepairPart> {
  const errors = validateRepairPart(input);
  if (errors.length > 0) throw new Error(errors.join("؛ "));

  const ticket = await getRepairTicket(ticketId);
  if (!ticket) throw new Error("تیکت یافت نشد.");
  assertOpen(ticket);

  const { rows } = await query<PartRow>(
    `INSERT INTO repair_ticket_parts (ticket_id, item_id, description, quantity, unit_cost, charge)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [ticketId, input.itemId ?? null, input.description.trim(), input.quantity, input.unitCost, input.charge],
  );
  return mapPart(rows[0]);
}

export async function removeRepairPart(id: string): Promise<void> {
  const { rows } = await query<{ status: RepairStatus }>(
    `SELECT t.status FROM repair_ticket_parts p JOIN repair_tickets t ON t.id = p.ticket_id WHERE p.id = $1`,
    [id],
  );
  if (!rows[0]) return;
  if (rows[0].status === "closed" || rows[0].status === "cancelled") {
    throw new Error("تیکت بسته‌شده یا لغوشده را نمی‌توان تغییر داد.");
  }
  await query(`DELETE FROM repair_ticket_parts WHERE id = $1`, [id]);
}

/** Edits the labor charge / VAT rate agreed with the customer while the ticket is still open. */
export async function updateRepairTicket(
  id: string,
  input: { laborCharge?: number; vatPercent?: number; reportedIssue?: string | null },
): Promise<RepairTicket> {
  const ticket = await getRepairTicket(id);
  if (!ticket) throw new Error("تیکت یافت نشد.");
  assertOpen(ticket);

  if (input.laborCharge != null && (!Number.isInteger(input.laborCharge) || input.laborCharge < 0)) {
    throw new Error("اجرت تعمیر باید یک عدد صحیح غیرمنفی (ریال) باشد.");
  }
  if (input.vatPercent != null && (!Number.isFinite(input.vatPercent) || input.vatPercent < 0 || input.vatPercent > 100)) {
    throw new Error("درصد مالیات باید بین ۰ تا ۱۰۰ باشد.");
  }

  const { rows } = await query<TicketRow>(
    `UPDATE repair_tickets
        SET labor_charge = COALESCE($2, labor_charge),
            vat_percent = COALESCE($3, vat_percent),
            reported_issue = COALESCE($4, reported_issue),
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, input.laborCharge ?? null, input.vatPercent ?? null, input.reportedIssue?.trim() || null],
  );
  return mapTicket(rows[0]);
}

/** Moves a ticket along the workflow. `closed` is deliberately unreachable here — see closeRepairTicket. */
export async function setRepairStatus(id: string, status: RepairStatus): Promise<RepairTicket> {
  const ticket = await getRepairTicket(id);
  if (!ticket) throw new Error("تیکت یافت نشد.");

  const error = validateRepairStatusTransition(ticket.status, status);
  if (error) throw new Error(error);

  // Phase 27 Wave 10 — work must not start (received → in_progress) until the
  // customer has approved the estimate. A ticket with no estimate at all is
  // untouched: pre-estimate behaviour is unchanged (acceptance criterion 6).
  if (status === "in_progress" && ticket.estimatedTotalRial > 0 && !ticket.estimateApprovedAt) {
    throw new Error("این تیکت برآورد هزینه دارد و هنوز تأیید مشتری را نگرفته است.");
  }

  const { rows } = await query<TicketRow>(
    `UPDATE repair_tickets SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status],
  );

  // A cancelled job goes back on the shelf if it was one of the shop's own
  // in-stock units when it came in (a customer's own watch has no serial
  // row to restore).
  if (status === "cancelled" && ticket.serialId) {
    await query(`UPDATE item_serials SET status = 'in_stock' WHERE id = $1 AND status = 'in_repair'`, [
      ticket.serialId,
    ]);
  }
  return mapTicket(rows[0]);
}

export interface CloseRepairTicketInput {
  businessId: string;
  ticketId: string;
  paymentMethod: SettlementMethod;
  createdBy?: string | null;
}

export interface CloseRepairTicketResult {
  breakdown: RepairChargeBreakdown;
  revenueEntryId: string | null;
  partsCostEntryId: string | null;
}

/**
 * Delivers and bills a repair, in the caller's own transaction. Two events,
 * for the same reason every other sale in this phase posts two: what the
 * customer paid and what the job cost the shop are separate facts. A
 * warranty job posts only the second — the revenue rule returns `null` on a
 * zero total, which the engine records as an event with no ledger effect.
 */
export async function closeRepairTicket(
  client: PoolClient,
  input: CloseRepairTicketInput,
): Promise<CloseRepairTicketResult> {
  const { rows: ticketRows } = await client.query<TicketRow>(
    `SELECT * FROM repair_tickets WHERE id = $1 FOR UPDATE`,
    [input.ticketId],
  );
  if (!ticketRows[0]) throw new Error("تیکت یافت نشد.");
  const ticket = mapTicket(ticketRows[0]);
  if (ticket.status === "closed") throw new Error("این تیکت قبلاً بسته شده است.");
  if (ticket.status === "cancelled") throw new Error("تیکت لغوشده را نمی‌توان بست.");
  // Phase 27 Wave 10 — an estimate the customer has not approved means the
  // shop must not start (and therefore cannot close) the job.
  if (ticket.estimatedTotalRial > 0 && !ticket.estimateApprovedAt) {
    throw new Error("این تیکت برآورد هزینه دارد و هنوز تأیید مشتری را نگرفته است.");
  }

  const { rows: partRows } = await client.query<{ charge_total: string | null }>(
    `SELECT SUM(charge)::text AS charge_total FROM repair_ticket_parts WHERE ticket_id = $1`,
    [input.ticketId],
  );

  const breakdown = computeRepairCharge({
    laborCharge: ticket.laborCharge,
    partsCharge: Number(partRows[0]?.charge_total ?? 0),
    vatPercent: ticket.vatPercent,
  });

  const { entryId: revenueEntryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: ticket.locationId,
    eventType: "watch.repair_revenue",
    payload: {
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      underWarranty: ticket.underWarranty,
      laborCharge: breakdown.laborCharge,
      partsCharge: breakdown.partsCharge,
      net: breakdown.net,
      vat: breakdown.vat,
      total: breakdown.total,
      paymentMethod: input.paymentMethod,
    },
    sourceType: "repair_ticket",
    sourceId: ticket.id,
    createdBy: input.createdBy ?? null,
  });

  const { entryId: partsCostEntryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: ticket.locationId,
    eventType: "watch.repair_cogs",
    payload: { ticketId: ticket.id, ticketNumber: ticket.ticketNumber },
    sourceType: "repair_ticket",
    sourceId: ticket.id,
    createdBy: input.createdBy ?? null,
  });

  await client.query(
    `UPDATE repair_tickets SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1`,
    [input.ticketId],
  );

  // The repaired unit leaves with its owner. One of the shop's own units
  // goes back on the shelf; a unit already marked sold stays sold.
  if (ticket.serialId) {
    await client.query(`UPDATE item_serials SET status = 'in_stock' WHERE id = $1 AND status = 'in_repair'`, [
      ticket.serialId,
    ]);
  }

  return { breakdown, revenueEntryId, partsCostEntryId };
}
