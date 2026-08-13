-- Phase 21 Wave 5 -- watch: serialized units, warranty, and repairs.
--
-- A watch business's stock is Wave 1's tracking='serial' items: one
-- `items` row per model, one `item_serials` row per physical unit. Wave 1
-- deliberately left that table with nothing but identity + status ("that
-- lifecycle is Wave 5's own design, not guessed at here") -- this migration
-- is that design.
--
-- Cost basis mirrors the call Wave 3 made for gold, deliberately: a single
-- average cost recorded on the unit at intake (item_serials.unit_cost), not
-- FIFO lots. A serialized unit is the easiest case for this -- one physical
-- unit, one purchase, one cost -- so there is no fungible-pool question to
-- defer here at all, unlike bulk gold.
ALTER TABLE item_serials
    -- What the shop paid for this specific unit (Rial). Nullable for the
    -- same reason item_weight_attributes.unit_cost_per_gram is: a unit can
    -- exist mid-intake before its cost is known, with the sale path itself
    -- refusing to sell a unit that still has none.
    ADD COLUMN unit_cost bigint CHECK (unit_cost IS NULL OR unit_cost > 0),
    -- The warranty term this unit is sold with, in months, agreed at intake
    -- (a model's standard terms) and overridable at the point of sale.
    -- 0 = sold with no warranty, which is a real answer, not a missing one.
    ADD COLUMN warranty_months integer NOT NULL DEFAULT 0 CHECK (warranty_months >= 0),
    ADD COLUMN sold_at date;

-- The warranty window itself, created at sale (never at intake) -- "warranty
-- terms starting at sale", per the phase doc. Separate from the months
-- column above because the two answer different questions: the column is
-- the terms the unit *would* be sold with, this row is the window that
-- actually *is* running for a unit that sold, which the warranty report and
-- the repair intake's under-warranty check both read.
CREATE TABLE serial_warranties (
    serial_id  uuid PRIMARY KEY REFERENCES item_serials(id) ON DELETE CASCADE,
    months     integer NOT NULL CHECK (months > 0),
    start_date date NOT NULL,
    end_date   date NOT NULL,
    notes      text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (end_date > start_date)
);

ALTER TABLE serial_warranties ENABLE ROW LEVEL SECURITY;
ALTER TABLE serial_warranties FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON serial_warranties FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM item_serials s JOIN items i ON i.id = s.item_id
         WHERE s.id = serial_warranties.serial_id AND app_owns_location(i.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM item_serials s JOIN items i ON i.id = s.item_id
         WHERE s.id = serial_warranties.serial_id AND app_owns_location(i.location_id)));

-- Per-location sequential ticket numbers, the same atomic
-- UPDATE ... RETURNING counter Phase 2 already uses for order numbers
-- (order_number_counters, migration 0003) rather than MAX(n)+1 -- a repair
-- ticket is a numbered document a customer walks out with, so it needs a
-- real number, and it needs it to be race-safe with a second person at the
-- counter.
CREATE TABLE repair_ticket_counters (
    location_id uuid PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
    next_number bigint NOT NULL DEFAULT 1
);

ALTER TABLE repair_ticket_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_ticket_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON repair_ticket_counters FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));

-- A repair/service job: intake -> parts consumed -> labor -> close.
--
-- serial_id is nullable on purpose: most repairs walking into a watch shop
-- are for a piece the shop never sold and has no serial row for. The
-- customer-facing identity of the item being repaired is therefore
-- item_description (free text), with serial_id an *optional* link to a unit
-- the shop does track -- which is what makes the warranty check possible
-- when it is set.
CREATE TABLE repair_tickets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    ticket_number   bigint NOT NULL,
    customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,
    serial_id       uuid REFERENCES item_serials(id) ON DELETE SET NULL,
    item_description text NOT NULL,
    reported_issue  text,
    status          text NOT NULL DEFAULT 'received'
                      CHECK (status IN ('received', 'in_progress', 'ready', 'closed', 'cancelled')),
    -- Set at intake from the linked serial's live warranty window (if any).
    -- Stored rather than re-derived at close because the window can expire
    -- between intake and close, and what governs the bill is the state on
    -- the day the shop took the piece in.
    under_warranty  boolean NOT NULL DEFAULT false,
    -- What the customer is billed for labor (اجرت تعمیر), Rial. Parts are
    -- billed per-line on repair_ticket_parts.
    labor_charge    bigint NOT NULL DEFAULT 0 CHECK (labor_charge >= 0),
    vat_percent     numeric(6, 3) NOT NULL DEFAULT 0 CHECK (vat_percent >= 0 AND vat_percent <= 100),
    closed_at       timestamptz,
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, ticket_number)
);
CREATE INDEX idx_repair_tickets_location_status ON repair_tickets (location_id, status);
CREATE INDEX idx_repair_tickets_serial ON repair_tickets (serial_id);

ALTER TABLE repair_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON repair_tickets FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));

-- One part consumed on a ticket. `unit_cost` is what the part cost the shop
-- (relieved from inventory at close); `charge` is what the customer pays
-- for it. The two are separate columns rather than one marked-up number
-- because they post to different sides of the ledger -- and because a
-- warranty repair charges nothing while still consuming a part that cost
-- real money.
CREATE TABLE repair_ticket_parts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id   uuid NOT NULL REFERENCES repair_tickets(id) ON DELETE CASCADE,
    -- Optional link to a tracked item this part came from; free-text
    -- `description` is the required identity, same reasoning as the ticket's
    -- own item_description above (a watch shop's parts drawer is not a
    -- catalogued inventory in v1).
    item_id     uuid REFERENCES items(id) ON DELETE SET NULL,
    description text NOT NULL,
    quantity    numeric(24, 9) NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_cost   bigint NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
    charge      bigint NOT NULL DEFAULT 0 CHECK (charge >= 0),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_repair_ticket_parts_ticket ON repair_ticket_parts (ticket_id);

ALTER TABLE repair_ticket_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_ticket_parts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON repair_ticket_parts FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM repair_tickets t
         WHERE t.id = repair_ticket_parts.ticket_id AND app_owns_location(t.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM repair_tickets t
         WHERE t.id = repair_ticket_parts.ticket_id AND app_owns_location(t.location_id)));
