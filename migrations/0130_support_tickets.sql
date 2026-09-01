-- ============================================================================
-- 0130_support_tickets.sql — support ticketing platform.
--
-- A member of a business can open a ticket from the dashboard's «پشتیبانی»
-- section: a subject, a category (technical / billing / account / feature /
-- other), a priority and a free-text description, optionally with one image
-- attachment per message (a downscaled data URL, the same shape bug reports
-- use). Every follow-up on either side is a message on the same ticket, so
-- the whole conversation stays in one thread.
--
-- Platform admins (the «support» role and above) answer and manage tickets
-- from the console: reply, re-prioritise, re-categorise, assign to another
-- admin, and move the ticket through its lifecycle (open → in_progress →
-- resolved → closed, with «waiting_customer» meaning the ball is in the
-- member's court). Every console write lands in platform_audit_log.
--
-- Tenancy: both tables are tenant-scoped exactly like every other business
-- table — RLS keyed on app_current_business() (see 0021), so a ticket is
-- only visible to the business that opened it, and a member can only ever
-- reach their own business's rows. The platform console reads and writes
-- through its deliberate tenant-bypass scope, as it does for bug reports.
-- `support_ticket_messages` carries its own business_id (denormalised from
-- the ticket at insert) so RLS can be enforced on it directly without a
-- subquery, the same shape as journal_lines.
-- ============================================================================

CREATE TABLE support_tickets (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id       uuid REFERENCES locations(id) ON DELETE SET NULL,
    user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
    subject           text NOT NULL,
    category          text NOT NULL DEFAULT 'other',
    priority          text NOT NULL DEFAULT 'normal',
    status            text NOT NULL DEFAULT 'open',
    assigned_admin_id uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    closed_at         timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT support_tickets_category_check CHECK (category IN ('technical', 'billing', 'account', 'feature', 'other')),
    CONSTRAINT support_tickets_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    CONSTRAINT support_tickets_status_check CHECK (status IN ('open', 'in_progress', 'waiting_customer', 'resolved', 'closed'))
);

CREATE INDEX idx_support_tickets_business_time ON support_tickets (business_id, created_at DESC);
CREATE INDEX idx_support_tickets_status ON support_tickets (status);
CREATE INDEX idx_support_tickets_assigned ON support_tickets (assigned_admin_id)
    WHERE assigned_admin_id IS NOT NULL;
CREATE INDEX idx_support_tickets_updated ON support_tickets (updated_at DESC);

CREATE TABLE support_ticket_messages (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id   uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    -- Denormalised from the ticket so RLS needs no subquery; kept in sync by
    -- the service layer (both sides insert through it).
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    author_type text NOT NULL CHECK (author_type IN ('member', 'admin')),
    user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
    admin_id    uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    body        text NOT NULL,
    -- A "data:image/..." data URL, downscaled client-side. NULL when the
    -- author chose not to attach an image.
    attachment  text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_support_ticket_messages_ticket ON support_ticket_messages (ticket_id, created_at);

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON support_tickets;
CREATE POLICY tenant_isolation ON support_tickets FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE support_ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ticket_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON support_ticket_messages;
CREATE POLICY tenant_isolation ON support_ticket_messages FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
