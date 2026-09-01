/**
 * The member half of the support ticketing platform (migration 0130).
 *
 * Every function here runs inside the ambient tenant scope established by
 * `withTenantScope` (src/lib/auth.ts), so RLS confines all reads and writes
 * to the session's business. The handlers pass `businessId`/`userId`/`role`
 * from the session — never from the request body — and this service enforces
 * the per-ticket rule on top of RLS: a member reaches only tickets they
 * opened, except owners and managers, who see the whole business queue
 * (`canSeeAllBusinessTickets`, src/lib/support-tickets.ts).
 *
 * The platform half of the same tables lives in platform-service.ts, which
 * reads and writes through the documented tenant-bypass scope.
 */
import { query } from "./db";
import type { Role } from "./auth-edge";
import {
  canSeeAllBusinessTickets,
  isMemberSettableStatus,
  isTicketCategory,
  isTicketPriority,
  isTicketOpen,
  statusAfterMemberReply,
  type TicketStatus,
} from "./support-tickets";

export const SUPPORT_SUBJECT_MAX = 150;
export const SUPPORT_BODY_MAX = 5000;
export const SUPPORT_ATTACHMENT_MAX = 4 * 1024 * 1024; // 4 MiB data URL

export interface SupportTicketSummary {
  id: string;
  businessId: string;
  locationId: string | null;
  locationName: string | null;
  userId: string | null;
  userName: string | null;
  subject: string;
  category: string;
  priority: string;
  status: string;
  assignedAdminId: string | null;
  assignedAdminName: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface SupportTicketMessage {
  id: string;
  ticketId: string;
  authorType: "member" | "admin";
  userId: string | null;
  userName: string | null;
  adminId: string | null;
  adminName: string | null;
  body: string;
  attachment: string | null;
  createdAt: string;
}

interface SupportTicketMessageRow extends Record<string, unknown> {
  id: string;
  ticket_id: string;
  author_type: "member" | "admin";
  user_id: string | null;
  user_name: string | null;
  admin_id: string | null;
  admin_name: string | null;
  body: string;
  attachment: string | null;
  created_at: string;
}

function toMessage(row: SupportTicketMessageRow): SupportTicketMessage {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    authorType: row.author_type,
    userId: row.user_id,
    userName: row.user_name,
    adminId: row.admin_id,
    adminName: row.admin_name,
    body: row.body,
    attachment: row.attachment,
    createdAt: row.created_at,
  };
}

export interface SupportTicketDetail extends SupportTicketSummary {
  messages: SupportTicketMessage[];
}

interface TicketRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  location_id: string | null;
  location_name: string | null;
  user_id: string | null;
  user_name: string | null;
  subject: string;
  category: string;
  priority: string;
  status: string;
  assigned_admin_id: string | null;
  assigned_admin_name: string | null;
  message_count: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

function toSummary(row: TicketRow): SupportTicketSummary {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    locationName: row.location_name,
    userId: row.user_id,
    userName: row.user_name,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    assignedAdminId: row.assigned_admin_id,
    assignedAdminName: row.assigned_admin_name,
    messageCount: Number(row.message_count),
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

const TICKET_SELECT = `
  SELECT t.id::text AS id, t.business_id::text AS business_id,
         t.location_id::text AS location_id, l.name AS location_name,
         t.user_id::text AS user_id, u.full_name AS user_name,
         t.subject, t.category, t.priority, t.status,
         t.assigned_admin_id::text AS assigned_admin_id, pa.full_name AS assigned_admin_name,
         (SELECT count(*) FROM support_ticket_messages m WHERE m.ticket_id = t.id)::text AS message_count,
         (SELECT max(m.created_at) FROM support_ticket_messages m WHERE m.ticket_id = t.id) AS last_message_at,
         (SELECT left(m.body, 200) FROM support_ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_preview,
         t.created_at, t.updated_at, t.closed_at
    FROM support_tickets t
    JOIN businesses b ON b.id = t.business_id
    LEFT JOIN locations l ON l.id = t.location_id
    LEFT JOIN users u ON u.id = t.user_id
    LEFT JOIN platform_admins pa ON pa.id = t.assigned_admin_id
`;

/**
 * The per-ticket access predicate on top of RLS: own tickets for everyone,
 * the whole business queue for owners and managers.
 */
function memberMaySee(role: Role, userId: string, ticketUserId: string | null, ticketBusinessId: string, businessId: string): boolean {
  if (businessId !== ticketBusinessId) return false;
  if (canSeeAllBusinessTickets(role)) return true;
  return ticketUserId === userId;
}

/** A member's tickets, newest activity first. */
export async function listMemberTickets({
  businessId,
  userId,
  role,
  status = "",
  limit = 200,
}: {
  businessId: string;
  userId: string;
  role: Role;
  status?: string;
  limit?: number;
}): Promise<SupportTicketSummary[]> {
  const safeLimit = Math.min(Math.max(Math.floor(limit) || 200, 1), 500);
  const { rows } = await query<TicketRow>(
    `${TICKET_SELECT}
      WHERE t.business_id = $1
        AND ($4 = '' OR t.status = $4)
        AND (t.user_id = $2 OR $3)
      ORDER BY t.updated_at DESC
      LIMIT $5`,
    [businessId, userId, canSeeAllBusinessTickets(role), status.trim().slice(0, 40), safeLimit],
  );
  return rows.map(toSummary);
}

/** One ticket with its full conversation; access-checked against the member. */
export async function getMemberTicket({
  businessId,
  userId,
  role,
  ticketId,
}: {
  businessId: string;
  userId: string;
  role: Role;
  ticketId: string;
}): Promise<SupportTicketDetail | null> {
  const { rows } = await query<TicketRow>(`${TICKET_SELECT} WHERE t.id = $1::uuid`, [ticketId]);
  const row = rows[0];
  if (!row) return null;
  if (!memberMaySee(role, userId, row.user_id, row.business_id, businessId)) return null;

  const { rows: messages } = await query<SupportTicketMessageRow>(
    `SELECT m.id::text AS id, m.ticket_id::text AS ticket_id, m.author_type AS author_type,
            m.user_id::text AS user_id, u.full_name AS user_name,
            m.admin_id::text AS admin_id, pa.full_name AS admin_name,
            m.body, m.attachment, m.created_at
       FROM support_ticket_messages m
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN platform_admins pa ON pa.id = m.admin_id
      WHERE m.ticket_id = $1::uuid
      ORDER BY m.created_at ASC`,
    [ticketId],
  );
  return { ...toSummary(row), messages: messages.map(toMessage) };
}

/** Opens a new ticket with its first message. */
export async function createMemberTicket({
  businessId,
  locationId,
  userId,
  subject,
  category,
  priority,
  body,
  attachment,
}: {
  businessId: string;
  locationId: string | null;
  userId: string;
  subject: string;
  category: string;
  priority: string;
  body: string;
  attachment: string | null;
}): Promise<SupportTicketDetail> {
  const cleanCategory = isTicketCategory(category) ? category : "other";
  const cleanPriority = isTicketPriority(priority) ? priority : "normal";

  const { rows: ticketRows } = await query<{ id: string }>(
    `INSERT INTO support_tickets (business_id, location_id, user_id, subject, category, priority)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [businessId, locationId, userId, subject, cleanCategory, cleanPriority],
  );
  const ticketId = ticketRows[0].id;

  await query(
    `INSERT INTO support_ticket_messages (ticket_id, business_id, author_type, user_id, body, attachment)
     VALUES ($1::uuid, $2, 'member', $3, $4, $5)`,
    [ticketId, businessId, userId, body, attachment],
  );

  // The inserts above just succeeded under RLS and the ticket is owned by
  // `userId`, so this re-read can only fail on a vanished row.
  const ticket = await getMemberTicket({ businessId, userId, role: "owner", ticketId });
  if (!ticket) throw new Error("ticket_not_found");
  return ticket;
}

/**
 * Adds a member reply. Reopens a resolved/closed ticket (a reply means the
 * problem is back on the table) and moves the status to `in_progress`.
 */
export async function addMemberMessage({
  businessId,
  userId,
  role,
  ticketId,
  body,
  attachment,
}: {
  businessId: string;
  userId: string;
  role: Role;
  ticketId: string;
  body: string;
  attachment: string | null;
}): Promise<SupportTicketMessage> {
  const ticket = await getMemberTicket({ businessId, userId, role, ticketId });
  if (!ticket) throw new TicketAccessError();

  const nextStatus: TicketStatus = statusAfterMemberReply(ticket.status);
  const { rows } = await query<{ id: string }>(
    `INSERT INTO support_ticket_messages (ticket_id, business_id, author_type, user_id, body, attachment)
     VALUES ($1::uuid, $2, 'member', $3, $4, $5)
     RETURNING id::text AS id`,
    [ticketId, businessId, userId, body, attachment],
  );
  // A reply means the problem is back on the table: reopen and re-queue.
  await query(
    `UPDATE support_tickets SET status = $2, updated_at = now(), closed_at = NULL WHERE id = $1::uuid`,
    [ticketId, nextStatus],
  );
  return getMessageById(ticketId, rows[0].id);
}

/** A member closes or reopens their own ticket. */
export async function setMemberTicketStatus({
  businessId,
  userId,
  role,
  ticketId,
  status,
}: {
  businessId: string;
  userId: string;
  role: Role;
  ticketId: string;
  status: string;
}): Promise<void> {
  if (!isMemberSettableStatus(status)) throw new Error("invalid_status");
  const ticket = await getMemberTicket({ businessId, userId, role, ticketId });
  if (!ticket) throw new TicketAccessError();

  await query(
    `UPDATE support_tickets
        SET status = $2, updated_at = now(),
            closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END
      WHERE id = $1::uuid`,
    [ticketId, status],
  );
}

async function getMessageById(ticketId: string, messageId: string | undefined): Promise<SupportTicketMessage> {
  const { rows } = await query<SupportTicketMessageRow>(
    `SELECT m.id::text AS id, m.ticket_id::text AS ticket_id, m.author_type AS author_type,
            m.user_id::text AS user_id, u.full_name AS user_name,
            m.admin_id::text AS admin_id, pa.full_name AS admin_name,
            m.body, m.attachment, m.created_at
       FROM support_ticket_messages m
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN platform_admins pa ON pa.id = m.admin_id
      WHERE m.ticket_id = $1::uuid AND m.id = $2::uuid`,
    [ticketId, messageId],
  );
  if (!rows[0]) throw new Error("message_not_found");
  return toMessage(rows[0]);
}

/** A member cannot see or touch this ticket at all (not theirs, not their business). */
export class TicketAccessError extends Error {
  constructor() {
    super("ticket_not_found");
  }
}

/** Human-facing validation for ticket fields shared by both surfaces. */
export function validateTicketInput({
  subject,
  body,
  attachment,
}: {
  /** Required on create; omitted on replies. */
  subject?: string;
  body: string;
  attachment: string | null;
}): { error: string | null } {
  if (subject !== undefined) {
    if (!subject.trim()) return { error: "subject_required" };
    if (subject.trim().length > SUPPORT_SUBJECT_MAX) return { error: "subject_too_long" };
  }
  if (!body.trim()) return { error: "body_required" };
  if (body.trim().length > SUPPORT_BODY_MAX) return { error: "body_too_long" };
  if (attachment && attachment.length > SUPPORT_ATTACHMENT_MAX) return { error: "attachment_too_large" };
  if (attachment && !attachment.startsWith("data:image/")) return { error: "attachment_invalid" };
  return { error: null };
}

/** Whether the member may still reply to this ticket — any ticket they can see
 * may receive a reply (replying to a closed/resolved one reopens it). */
export function memberMayReply(status: string): boolean {
  return isTicketOpen(status) || status === "resolved" || status === "closed";
}
