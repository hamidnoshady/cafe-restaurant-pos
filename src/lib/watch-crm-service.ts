/**
 * Phase 27 Wave 10 — the watch flagship (DB-touching): service/battery
 * reminders, pre-owned intake provenance, and the repair estimate → approval
 * step.
 *
 * Reminders derive from the model's service interval: a sold unit comes due
 * `service_interval_months` after its sale date (a quartz battery ~2 years,
 * an automatic movement 3–5), so no new calendar table is needed. Pre-owned
 * intake records a condition grade and the box-and-papers checklist on the
 * serial. A repair estimate is recorded on the ticket, approved by the
 * customer, and moving to `in_progress`/closing without approval is refused
 * (repairs-service.ts).
 */
import { query } from "./db";
import {
  serviceDueDate,
  serviceReminderState,
  validateConditionGrade,
  type ConditionGrade,
  type ServiceReminderState,
} from "./watch";
import { renderRepairEstimate } from "./repair-estimate";

export interface ServiceReminderRow {
  serialId: string;
  serialNumber: string;
  itemName: string;
  customerName: string | null;
  /** The ISO date the unit comes due for service (sale date + interval). */
  referenceDate: string;
  state: ServiceReminderState;
}

/**
 * Sold units whose next service is within `leadDays` or past — the
 * due-for-service list the shop's home page surfaces. The reference is the
 * sale date plus the model's service interval; a model without an interval
 * never appears.
 */
export async function serviceReminders(
  locationId: string,
  todayIso: string,
  leadDays: number,
): Promise<ServiceReminderRow[]> {
  const { rows } = await query<{
    serial_id: string;
    serial_number: string;
    item_name: string;
    sold_at: string | null;
    service_interval_months: number | null;
  }>(
    `SELECT s.id AS serial_id, s.serial_number, i.name AS item_name,
            s.sold_at::text AS sold_at, i.service_interval_months
       FROM item_serials s
       JOIN items i ON i.id = s.item_id
      WHERE i.location_id = $1 AND s.status = 'sold' AND s.sold_at IS NOT NULL`,
    [locationId],
  );

const reminders: ServiceReminderRow[] = [];
  for (const r of rows) {
    const reference = serviceDueDate(r.sold_at, r.service_interval_months);
    if (!reference) continue;
    const state = serviceReminderState(reference, todayIso, leadDays);
    if (state === "ok") continue;
    reminders.push({
      serialId: r.serial_id,
      serialNumber: r.serial_number,
      itemName: r.item_name,
      customerName: null,
      referenceDate: reference,
      state,
    });
  }
  return reminders.sort((a, b) => a.referenceDate.localeCompare(b.referenceDate));
}

export async function recordPreOwnedIntake(
  serialId: string,
  input: { conditionGrade: ConditionGrade; boxAndPapers: boolean },
): Promise<void> {
  const error = validateConditionGrade(input.conditionGrade);
  if (error) throw new Error(error);

  const { rowCount } = await query(
    `UPDATE item_serials SET condition_grade = $2, box_and_papers = $3, pre_owned = true WHERE id = $1`,
    [serialId, input.conditionGrade, input.boxAndPapers],
  );
  if (rowCount === 0) throw new Error("سریال یافت نشد.");
}

export interface RepairEstimateRecord {
  ticketId: string;
  estimatedLaborRial: number;
  estimatedPartsRial: number;
  estimatedTotalRial: number;
  approvedAt: string | null;
}

/**
 * Records (or replaces) the estimate on an open ticket — the labour/parts
 * breakdown the customer will be asked to approve. Re-stamping clears any
 * prior approval: a changed number is a new document to approve.
 */
export async function setRepairEstimate(
  ticketId: string,
  input: { laborRial: number; partsRial: number },
): Promise<RepairEstimateRecord> {
  const { laborRial, partsRial } = input;
  if (!Number.isInteger(laborRial) || laborRial < 0 || !Number.isInteger(partsRial) || partsRial < 0) {
    throw new Error("اجرت و قطعات برآورد باید اعداد صحیح غیرمنفی (ریال) باشند.");
  }
  const { rows } = await query<{ status: string; estimate_approved_at: string | null }>(
    `SELECT status::text, estimate_approved_at FROM repair_tickets WHERE id = $1`,
    [ticketId],
  );
  if (!rows[0]) throw new Error("تیکت یافت نشد.");
  if (rows[0].status === "closed" || rows[0].status === "cancelled") {
    throw new Error("تیکت بسته‌شده یا لغوشده را نمی‌توان برآورد کرد.");
  }

  const estimatedTotalRial = laborRial + partsRial;
  const { rows: updated } = await query<{ estimate_approved_at: string | null }>(
    `UPDATE repair_tickets
        SET estimated_total_rial = $2, estimated_labor_rial = $3, estimated_parts_rial = $4,
            estimated_at = now(), estimate_approved_at = NULL, updated_at = now()
      WHERE id = $1 RETURNING estimate_approved_at`,
    [ticketId, estimatedTotalRial, laborRial, partsRial],
  );
  return {
    ticketId,
    estimatedLaborRial: laborRial,
    estimatedPartsRial: partsRial,
    estimatedTotalRial,
    approvedAt: updated[0].estimate_approved_at,
  };
}

/** The customer's approval: stamps the ticket, so closeRepairTicket can proceed. */
export async function approveRepairEstimate(ticketId: string): Promise<RepairEstimateRecord> {
  const { rows } = await query<{
    status: string;
    estimated_labor_rial: string;
    estimated_parts_rial: string;
    estimated_total_rial: string;
    estimate_approved_at: string | null;
  }>(
    `SELECT status::text, estimated_labor_rial::text, estimated_parts_rial::text,
            estimated_total_rial::text, estimate_approved_at
       FROM repair_tickets WHERE id = $1`,
    [ticketId],
  );
  if (!rows[0]) throw new Error("تیکت یافت نشد.");
  if (rows[0].status === "closed" || rows[0].status === "cancelled") {
    throw new Error("تیکت بسته‌شده یا لغوشده را نمی‌توان تأیید کرد.");
  }
  if (Number(rows[0].estimated_total_rial) <= 0) {
    throw new Error("این تیکت برآورد هزینه ندارد.");
  }

  const { rows: updated } = await query<{ estimate_approved_at: string | null }>(
    `UPDATE repair_tickets SET estimate_approved_at = now(), updated_at = now() WHERE id = $1 RETURNING estimate_approved_at`,
    [ticketId],
  );
  return {
    ticketId,
    estimatedLaborRial: Number(rows[0].estimated_labor_rial),
    estimatedPartsRial: Number(rows[0].estimated_parts_rial),
    estimatedTotalRial: Number(rows[0].estimated_total_rial),
    approvedAt: updated[0].estimate_approved_at,
  };
}

interface EstimateRow extends Record<string, unknown> {
  ticket_number: string;
  item_description: string;
  reported_issue: string | null;
  estimated_labor_rial: string;
  estimated_parts_rial: string;
  estimated_total_rial: string;
  customer_name: string | null;
}

/** Renders the printable estimate for a ticket's current estimate. */
export async function repairEstimateText(ticketId: string, todayIso: string): Promise<string> {
  const { rows } = await query<EstimateRow>(
    `SELECT t.ticket_number::text AS ticket_number, t.item_description, t.reported_issue,
            t.estimated_labor_rial::text AS estimated_labor_rial,
            t.estimated_parts_rial::text AS estimated_parts_rial,
            t.estimated_total_rial::text AS estimated_total_rial, c.name AS customer_name
       FROM repair_tickets t LEFT JOIN customers c ON c.id = t.customer_id
      WHERE t.id = $1`,
    [ticketId],
  );
  if (!rows[0]) throw new Error("تیکت یافت نشد.");
  return renderRepairEstimate({
    ticketNumber: Number(rows[0].ticket_number),
    itemDescription: rows[0].item_description,
    reportedIssue: rows[0].reported_issue,
    laborCharge: Number(rows[0].estimated_labor_rial),
    partsCharge: Number(rows[0].estimated_parts_rial),
    estimatedTotalRial: Number(rows[0].estimated_total_rial),
    customerName: rows[0].customer_name,
    todayIso,
  });
}
