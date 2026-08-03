-- ============================================================================
-- 0045_employee_shifts.sql — Phase 20 Wave 5: shift tracking
--
-- Phase 8's v_shift_reconciliation (migration 0008) has always been a proxy:
-- "one row per (location, business day, closing cashier)" because no
-- till-open/till-close or clock-in/clock-out entity existed anywhere in the
-- schema (see that migration's comment, and the Phase 8 doc's "no shift/till
-- entity exists" decision). This wave adds the real thing: an employee opens
-- a shift (optionally counting a starting cash float) and closes it later
-- (optionally counting the drawer), the same self-service shape Wave 2 gave
-- sessions and Wave 3 gave biometric credentials.
--
-- Deliberately NOT wired into orders/payments (no new FK there, no change to
-- order-service.ts): a shift's sales are read back on demand by joining
-- orders.closed_by + orders.closed_at against the shift's own
-- [started_at, ended_at] window (see shift-service.ts's shiftCashSummary) —
-- exactly the join v_shift_reconciliation already does per business-day,
-- just narrowed to one shift's actual window instead of a whole calendar
-- day. That keeps this migration's (and this wave's) blast radius confined
-- to one new table, the same isolation Wave 1 kept for employee_sessions.
--
-- location_id/device_id are copied from the employee_sessions row open at
-- the moment the shift starts (employee-service.ts's createSession already
-- records both there since Wave 2/4) rather than re-resolved from a device
-- token — resolving Wave 4's open question 2 (which terminal a shift's
-- orders were rung in on) without introducing any new device-token plumbing
-- into the already-authenticated dashboard routes this wave adds.
-- ============================================================================

-- Nothing referenced employee_sessions by its (id, business_id) pair before
-- this wave (its own FKs all point the other way); employee_shifts.session_id
-- is the first, so the composite unique constraint every other Wave 1-4
-- table already carries has to be added here instead of amending 0042.
ALTER TABLE employee_sessions
    ADD CONSTRAINT employee_sessions_id_business_unique UNIQUE (id, business_id);

CREATE TABLE employee_shifts (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id    uuid NOT NULL,
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id    uuid,
    session_id     uuid,
    device_id      uuid,
    opening_float  bigint CHECK (opening_float IS NULL OR opening_float >= 0), -- Rial; null = float not tracked for this shift
    closing_float  bigint CHECK (closing_float IS NULL OR closing_float >= 0),
    business_date  date NOT NULL,
    started_at     timestamptz NOT NULL DEFAULT now(),
    ended_at       timestamptz,
    closed_by      uuid REFERENCES users(id) ON DELETE SET NULL, -- usually the employee themself; differs on an admin force-close
    CONSTRAINT employee_shifts_employee_business_fk
        FOREIGN KEY (employee_id, business_id)
        REFERENCES employees (id, business_id)
        ON DELETE CASCADE,
    CONSTRAINT employee_shifts_location_business_fk
        FOREIGN KEY (location_id, business_id)
        REFERENCES locations (id, business_id)
        ON DELETE SET NULL,
    CONSTRAINT employee_shifts_session_business_fk
        FOREIGN KEY (session_id, business_id)
        REFERENCES employee_sessions (id, business_id)
        ON DELETE SET NULL,
    CONSTRAINT employee_shifts_device_business_fk
        FOREIGN KEY (device_id, business_id)
        REFERENCES pos_devices (id, business_id)
        ON DELETE SET NULL,
    CONSTRAINT employee_shifts_ended_after_started CHECK (ended_at IS NULL OR ended_at >= started_at)
);
-- At most one open shift per employee at a time — starting a new one while
-- one is already open is a caller error (shift-service.ts's openShift turns
-- the resulting unique_violation into a clear "shift_already_open").
CREATE UNIQUE INDEX idx_employee_shifts_employee_open
    ON employee_shifts (employee_id) WHERE ended_at IS NULL;
CREATE INDEX idx_employee_shifts_business_date
    ON employee_shifts (business_id, business_date);
CREATE INDEX idx_employee_shifts_location_open
    ON employee_shifts (location_id) WHERE ended_at IS NULL;

ALTER TABLE employee_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_shifts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON employee_shifts FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
