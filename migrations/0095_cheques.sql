-- Cheques (چک) — the subledger, and the one thing this system had no
-- representation of at all.
--
-- Until now `payment_method` was cash/card/card_to_card/online/credit/snappfood
-- and nothing else: a business that took a post-dated cheque from a customer, or
-- wrote one to a supplier, had to record the whole life of it as manual journal
-- entries, against accounts that did not exist either. That is most of the trade
-- credit in an Iranian business, and none of it was visible.
--
-- A cheque is not a payment; it is a promise with a date on it and a life of its
-- own, which is why it needs a row rather than a `payments` slice. What the
-- register has to answer — "what is due next week", "which of these has been
-- deposited", "whose cheque bounced" — is a question about that life, and a
-- single balance in 1240 cannot answer any of it.
--
-- Two directions, one table. A cheque we hold (`receivable`) and a cheque we
-- wrote (`payable`) have the same fields — serial, bank, صیاد id, amount, due
-- date, counterparty — and differ only in which statuses they can be in and
-- which accounts their transitions post to. Splitting them into two tables would
-- duplicate the register, the due-date query and the RLS policy to express that.
--
-- The lifecycle (see src/lib/cheques.ts for the authoritative transition table):
--
--   receivable: on_hand ──deposit──▶ in_collection ──clear──▶ cleared
--                  │                       │
--                  │                       └──bounce──▶ bounced
--                  └──endorse──▶ endorsed ──clear──▶ cleared
--                                    └──bounce──▶ bounced
--
--   payable:    issued ──present──▶ cleared
--                  ├──bounce──▶ bounced
--                  └──cancel──▶ cancelled
--
-- `endorsed` (ظهرنویسی — passing a customer's cheque on to a supplier) is a
-- status here and NOT a ledger account, deliberately. An endorsed cheque is
-- contingent: it has left our assets, but if it bounces the supplier comes back
-- to us. Carrying it as an asset needs an unbalanced memo pair, so instead the
-- endorsement posts Debit accounts payable / Credit چک‌های نزد صندوق — the
-- supplier's balance really does go down — and a later bounce is a real entry
-- (Debit چک‌های برگشتی / Credit accounts payable) that puts the bad cheque back
-- on our books and the debt back on theirs. The contingency lives in this table,
-- where the register can show it, rather than in an account that cannot balance.

CREATE TYPE cheque_direction AS ENUM ('receivable', 'payable');

CREATE TYPE cheque_status AS ENUM (
    'on_hand',        -- receivable: taken, still in the drawer
    'in_collection',  -- receivable: handed to the bank
    'endorsed',       -- receivable: passed to a supplier, not yet cleared
    'issued',         -- payable: written, not yet presented
    'cleared',        -- terminal: the money moved
    'bounced',        -- terminal-ish: dishonoured (a receivable can be re-presented by creating a new row)
    'cancelled'       -- terminal: a cheque we wrote and voided before it was presented
);

CREATE TABLE cheques (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id   uuid REFERENCES locations(id) ON DELETE SET NULL,
    direction     cheque_direction NOT NULL,
    status        cheque_status NOT NULL,

    -- What is printed on the cheque. `serial_number` is the bank's number;
    -- `sayad_id` is the 16-digit شناسه صیاد every Iranian cheque has carried
    -- since the صیاد system, and is what a counterparty will quote back. Both are
    -- text: they are identifiers, never arithmetic.
    serial_number text NOT NULL CHECK (btrim(serial_number) <> ''),
    sayad_id      text CHECK (sayad_id IS NULL OR sayad_id ~ '^[0-9]{16}$'),
    bank_name     text NOT NULL CHECK (btrim(bank_name) <> ''),
    account_number text,

    -- Integer Rial, like every other money column in this schema.
    amount        bigint NOT NULL CHECK (amount > 0),
    issue_date    date NOT NULL,
    due_date      date NOT NULL,

    -- Who wrote it (receivable) or who it is made out to (payable). The name is
    -- always recorded; the FK is set when the counterparty is one we know.
    counterparty_name text NOT NULL CHECK (btrim(counterparty_name) <> ''),
    customer_id   uuid REFERENCES customers(id) ON DELETE SET NULL,
    supplier_id   uuid REFERENCES suppliers(id) ON DELETE SET NULL,

    memo          text,
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    -- A direction can only hold its own statuses. Cheap, and it makes an
    -- illegal state unrepresentable rather than merely untested.
    CONSTRAINT cheques_status_matches_direction CHECK (
        (direction = 'receivable' AND status IN ('on_hand', 'in_collection', 'endorsed', 'cleared', 'bounced'))
        OR (direction = 'payable' AND status IN ('issued', 'cleared', 'bounced', 'cancelled'))
    ),
    -- One cheque is one row: the same bank's same serial cannot be entered twice
    -- for a business, which is the mistake a busy counter actually makes.
    CONSTRAINT cheques_unique_serial UNIQUE (business_id, bank_name, serial_number),
    CONSTRAINT cheques_unique_sayad UNIQUE (business_id, sayad_id)
);

-- The register's own query: what is due, per direction, soonest first.
CREATE INDEX idx_cheques_due ON cheques (business_id, direction, status, due_date);
CREATE INDEX idx_cheques_customer ON cheques (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_cheques_supplier ON cheques (supplier_id) WHERE supplier_id IS NOT NULL;

ALTER TABLE cheques ENABLE ROW LEVEL SECURITY;
ALTER TABLE cheques FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cheques FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Every transition, append-only, each linked to the entry it posted. `cheques`
-- stays current-state-only and this is the history — the same split every other
-- audited entity in this schema uses, and what makes "why is this cheque in
-- 1244" answerable without reading the ledger backwards.
CREATE TABLE cheque_events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    cheque_id     uuid NOT NULL REFERENCES cheques(id) ON DELETE CASCADE,
    event         text NOT NULL CHECK (event IN ('received', 'issued', 'deposited', 'endorsed', 'cleared', 'bounced', 'cancelled')),
    -- The day the transition happened, which is also the entry_date it posted
    -- on — so the fiscal-period lock (migration 0024) applies to a cheque
    -- movement exactly as it does to everything else.
    occurred_on   date NOT NULL,
    entry_id      uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    -- Set only on 'endorsed': who the cheque was passed to.
    endorsed_to_supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
    memo          text,
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_cheque_events_cheque ON cheque_events (cheque_id, created_at);

ALTER TABLE cheque_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cheque_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cheque_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
