-- ============================================================================
-- 0004_table_management_reservations.sql — Phase 3 (Table Management & Reservations)
--
--   * Floor plan: tables are grouped into `floor_sections` and carry a
--     free-form canvas position (pos_x/pos_y) + size + shape, so the manager
--     can lay out a map matching the real venue. A section may be owned by a
--     waiter (`assigned_waiter_id`) — consumed by the Waiter app in Phase 4.
--   * `table_sessions`: the lifecycle object that opens when guests are
--     seated, groups multiple order rounds, and closes on checkout. A session
--     can span several physical tables (merge for large groups) via
--     `table_session_tables`; a partial unique index guarantees a table
--     belongs to at most one *active* session at a time.
--   * Table state machine adds 'bill_requested' to `table_status`
--     (free → seated → bill_requested → cleaning → free).
--   * Reservations gain a turn time (`duration_minutes`) for overlap
--     detection and a link to the session created when they are seated.
-- ============================================================================

-- New table state. (ADD VALUE must not be *used* in this same transaction —
-- it is only referenced at runtime by the app, so this is safe.)
ALTER TYPE table_status ADD VALUE IF NOT EXISTS 'bill_requested';

-- ---------------------------------------------------------------------------
-- Floor sections (zones on the map) + waiter ownership
-- ---------------------------------------------------------------------------
CREATE TABLE floor_sections (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id        uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name               text NOT NULL,
    color              text,                       -- optional map tint, e.g. '#f59e0b'
    assigned_waiter_id uuid REFERENCES users(id) ON DELETE SET NULL,
    sort_order         integer NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, name)
);
CREATE INDEX idx_floor_sections_location ON floor_sections (location_id);

-- Floor-plan geometry + section grouping for each table.
ALTER TABLE dining_tables
    ADD COLUMN section_id uuid REFERENCES floor_sections(id) ON DELETE SET NULL,
    ADD COLUMN pos_x  integer NOT NULL DEFAULT 0,
    ADD COLUMN pos_y  integer NOT NULL DEFAULT 0,
    ADD COLUMN width  integer NOT NULL DEFAULT 80  CHECK (width  > 0),
    ADD COLUMN height integer NOT NULL DEFAULT 80  CHECK (height > 0),
    ADD COLUMN shape  text NOT NULL DEFAULT 'rect' CHECK (shape IN ('rect', 'circle'));
CREATE INDEX idx_dining_tables_section ON dining_tables (section_id);

-- ---------------------------------------------------------------------------
-- Table sessions (seating → rounds → checkout)
-- ---------------------------------------------------------------------------
CREATE TABLE table_sessions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    primary_table_id  uuid REFERENCES dining_tables(id) ON DELETE SET NULL,
    status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    party_size        integer CHECK (party_size IS NULL OR party_size > 0),
    guest_name        text,
    guest_phone       text,
    reservation_id    uuid,   -- FK added after reservations gains its columns below
    note              text,
    opened_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    closed_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    opened_at         timestamptz NOT NULL DEFAULT now(),
    bill_requested_at timestamptz,
    closed_at         timestamptz
);
CREATE INDEX idx_table_sessions_location_status ON table_sessions (location_id, status);
CREATE INDEX idx_table_sessions_primary_table ON table_sessions (primary_table_id);

-- Which physical tables a session occupies. released_at IS NULL = still held;
-- the partial unique index forbids a table being in two active sessions.
CREATE TABLE table_session_tables (
    session_id  uuid NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
    table_id    uuid NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
    joined_at   timestamptz NOT NULL DEFAULT now(),
    released_at timestamptz,
    PRIMARY KEY (session_id, table_id)
);
CREATE UNIQUE INDEX idx_table_session_tables_active
    ON table_session_tables (table_id) WHERE released_at IS NULL;

-- Orders now belong to a session (a session groups several order rounds).
ALTER TABLE orders
    ADD COLUMN table_session_id uuid REFERENCES table_sessions(id) ON DELETE SET NULL;
CREATE INDEX idx_orders_table_session ON orders (table_session_id);

-- ---------------------------------------------------------------------------
-- Reservations: turn time + link to the session created on seating
-- ---------------------------------------------------------------------------
ALTER TABLE reservations
    ADD COLUMN duration_minutes integer NOT NULL DEFAULT 90 CHECK (duration_minutes > 0),
    ADD COLUMN seated_session_id uuid REFERENCES table_sessions(id) ON DELETE SET NULL,
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX idx_reservations_table_time ON reservations (table_id, reserved_at);

ALTER TABLE table_sessions
    ADD CONSTRAINT table_sessions_reservation_fk
        FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE SET NULL;
