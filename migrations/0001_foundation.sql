-- ============================================================================
-- 0001_foundation.sql — full schema for the Cafe/Restaurant POS
--
-- Covers ALL tables from the master spec, including later-phase ones
-- (menu/orders, tables/reservations, offline sync, inventory, ledger,
-- delivery), so we migrate once instead of incrementally.
--
-- Conventions:
--   * Primary keys: uuid, gen_random_uuid()
--   * Money: BIGINT, smallest unit (Rial). Display formatting (Toman,
--     Persian digits) happens at the display layer only.
--   * Dates/times: timestamptz, ISO/Gregorian. Jalali is display-only.
--   * Multi-location: every tenant-scoped table carries location_id.
--     business_id is the top-level tenant; some tables (users, customers,
--     chart of accounts) are business-scoped with nullable location_id.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS citext; -- case-insensitive email

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('owner', 'manager', 'cashier', 'waiter', 'kitchen');

CREATE TYPE order_type AS ENUM ('dine_in', 'takeaway', 'delivery');
CREATE TYPE order_status AS ENUM ('open', 'held', 'completed', 'voided');
CREATE TYPE order_item_status AS ENUM ('pending', 'sent', 'preparing', 'ready', 'served', 'voided');
CREATE TYPE payment_method AS ENUM ('cash', 'card', 'card_to_card', 'online', 'credit');

CREATE TYPE table_status AS ENUM ('free', 'seated', 'reserved', 'cleaning', 'out_of_service');
CREATE TYPE reservation_status AS ENUM ('booked', 'seated', 'completed', 'cancelled', 'no_show');

CREATE TYPE device_kind AS ENUM ('cashier', 'waiter', 'kds', 'dashboard', 'printer_bridge');
CREATE TYPE printer_kind AS ENUM ('receipt', 'kitchen');

CREATE TYPE stock_movement_type AS ENUM ('purchase', 'sale', 'waste', 'adjustment', 'transfer_in', 'transfer_out');
CREATE TYPE purchase_status AS ENUM ('draft', 'ordered', 'received', 'cancelled');

CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');

CREATE TYPE delivery_status AS ENUM ('pending', 'assigned', 'out_for_delivery', 'delivered', 'failed');

-- ---------------------------------------------------------------------------
-- Tenancy: business & locations
-- ---------------------------------------------------------------------------
CREATE TABLE businesses (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE locations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name        text NOT NULL,
    address     text,
    phone       text,
    timezone    text NOT NULL DEFAULT 'Asia/Tehran',
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_locations_business ON locations (business_id);

-- Key/value settings. location_id NULL = business-wide setting.
CREATE TABLE settings (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
    key         text NOT NULL,
    value       jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (business_id, location_id, key)
);

-- ---------------------------------------------------------------------------
-- Users & auth
-- ---------------------------------------------------------------------------
-- Owner/Manager: email + password (JWT session).
-- Cashier/Waiter/Kitchen: 4-digit PIN quick-login, scoped to a location.
-- location_id NULL = access to all locations (owner, roaming manager).
CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id   uuid REFERENCES locations(id) ON DELETE SET NULL,
    role          user_role NOT NULL,
    full_name     text NOT NULL,
    email         citext UNIQUE,
    password_hash text,
    pin_hash      text,
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_credentials CHECK (password_hash IS NOT NULL OR pin_hash IS NOT NULL)
);
CREATE INDEX idx_users_business ON users (business_id);
CREATE INDEX idx_users_location ON users (location_id) WHERE location_id IS NOT NULL;

CREATE TABLE audit_log (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
    user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
    action      text NOT NULL,
    entity      text,
    entity_id   text,
    payload     jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_business_time ON audit_log (business_id, created_at);

-- ---------------------------------------------------------------------------
-- Menu (Phase 2)
-- ---------------------------------------------------------------------------
CREATE TABLE menu_categories (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name        text NOT NULL,
    sort_order  integer NOT NULL DEFAULT 0,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_menu_categories_location ON menu_categories (location_id);

CREATE TABLE menu_items (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    category_id uuid REFERENCES menu_categories(id) ON DELETE SET NULL,
    name        text NOT NULL,
    description text,
    sku         text,
    price       bigint NOT NULL CHECK (price >= 0), -- Rial
    image_url   text,
    is_active   boolean NOT NULL DEFAULT true,
    sort_order  integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_menu_items_location ON menu_items (location_id);
CREATE INDEX idx_menu_items_category ON menu_items (category_id);

CREATE TABLE modifier_groups (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name        text NOT NULL,
    min_select  integer NOT NULL DEFAULT 0,
    max_select  integer NOT NULL DEFAULT 1,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_modifier_groups_location ON modifier_groups (location_id);

CREATE TABLE modifiers (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    group_id      uuid NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
    name          text NOT NULL,
    price_delta   bigint NOT NULL DEFAULT 0, -- Rial, may be negative
    is_active     boolean NOT NULL DEFAULT true,
    sort_order    integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_modifiers_group ON modifiers (group_id);

CREATE TABLE menu_item_modifier_groups (
    menu_item_id      uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    modifier_group_id uuid NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (menu_item_id, modifier_group_id)
);

-- ---------------------------------------------------------------------------
-- Tables & reservations (Phase 3)
-- ---------------------------------------------------------------------------
CREATE TABLE dining_tables (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name        text NOT NULL,
    zone        text,
    capacity    integer NOT NULL DEFAULT 2 CHECK (capacity > 0),
    status      table_status NOT NULL DEFAULT 'free',
    sort_order  integer NOT NULL DEFAULT 0,
    is_active   boolean NOT NULL DEFAULT true,
    UNIQUE (location_id, name)
);
CREATE INDEX idx_dining_tables_location ON dining_tables (location_id);

CREATE TABLE customers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
    name        text NOT NULL,
    phone       text,
    address     text,
    notes       text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_business ON customers (business_id);
CREATE INDEX idx_customers_phone ON customers (business_id, phone);

CREATE TABLE reservations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    table_id      uuid REFERENCES dining_tables(id) ON DELETE SET NULL,
    customer_id   uuid REFERENCES customers(id) ON DELETE SET NULL,
    customer_name text NOT NULL,
    customer_phone text,
    party_size    integer NOT NULL DEFAULT 2 CHECK (party_size > 0),
    reserved_at   timestamptz NOT NULL,
    status        reservation_status NOT NULL DEFAULT 'booked',
    notes         text,
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reservations_location_time ON reservations (location_id, reserved_at);

-- ---------------------------------------------------------------------------
-- Orders & payments (Phases 2 & 4)
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id    uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    order_number   bigint NOT NULL, -- per-location sequential, assigned by app
    type           order_type NOT NULL DEFAULT 'dine_in',
    status         order_status NOT NULL DEFAULT 'open',
    table_id       uuid REFERENCES dining_tables(id) ON DELETE SET NULL,
    customer_id    uuid REFERENCES customers(id) ON DELETE SET NULL,
    guest_count    integer,
    subtotal       bigint NOT NULL DEFAULT 0, -- Rial
    discount       bigint NOT NULL DEFAULT 0,
    service_charge bigint NOT NULL DEFAULT 0,
    tax            bigint NOT NULL DEFAULT 0,
    total          bigint NOT NULL DEFAULT 0,
    note           text,
    opened_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    closed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    opened_at      timestamptz NOT NULL DEFAULT now(),
    closed_at      timestamptz,
    voided_reason  text,
    UNIQUE (location_id, order_number)
);
CREATE INDEX idx_orders_location_status ON orders (location_id, status);
CREATE INDEX idx_orders_location_opened ON orders (location_id, opened_at);

CREATE TABLE order_items (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id    uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id   uuid REFERENCES menu_items(id) ON DELETE SET NULL,
    name_snapshot  text NOT NULL,          -- menu item name at time of sale
    unit_price     bigint NOT NULL,        -- Rial, price at time of sale
    quantity       integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
    status         order_item_status NOT NULL DEFAULT 'pending',
    note           text,
    sent_to_kitchen_at timestamptz,
    ready_at       timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_items_order ON order_items (order_id);
CREATE INDEX idx_order_items_location_status ON order_items (location_id, status);

CREATE TABLE order_item_modifiers (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_item_id  uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    modifier_id    uuid REFERENCES modifiers(id) ON DELETE SET NULL,
    name_snapshot  text NOT NULL,
    price_delta    bigint NOT NULL DEFAULT 0
);
CREATE INDEX idx_order_item_modifiers_item ON order_item_modifiers (order_item_id);

CREATE TABLE payments (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    method      payment_method NOT NULL,
    amount      bigint NOT NULL CHECK (amount <> 0), -- negative = refund
    reference   text,                                -- terminal ref, card no. suffix, …
    received_by uuid REFERENCES users(id) ON DELETE SET NULL,
    received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_order ON payments (order_id);
CREATE INDEX idx_payments_location_time ON payments (location_id, received_at);

-- ---------------------------------------------------------------------------
-- Devices, printers, offline sync (Phase 5)
-- ---------------------------------------------------------------------------
CREATE TABLE devices (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name         text NOT NULL,
    kind         device_kind NOT NULL,
    last_seen_at timestamptz,
    is_active    boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_devices_location ON devices (location_id);

CREATE TABLE printers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name        text NOT NULL,
    kind        printer_kind NOT NULL,
    connection  jsonb NOT NULL DEFAULT '{}'::jsonb, -- ip/port/usb path/driver opts
    is_active   boolean NOT NULL DEFAULT true
);
CREATE INDEX idx_printers_location ON printers (location_id);

-- Server-side inbox for events replayed from offline clients.
-- client_event_id is the client-generated idempotency key.
CREATE TABLE sync_events (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    device_id       uuid REFERENCES devices(id) ON DELETE SET NULL,
    client_event_id uuid NOT NULL,
    event_type      text NOT NULL,
    payload         jsonb NOT NULL,
    occurred_at     timestamptz NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT now(),
    applied_at      timestamptz,
    error           text,
    UNIQUE (location_id, client_event_id)
);
CREATE INDEX idx_sync_events_unapplied ON sync_events (location_id) WHERE applied_at IS NULL;

-- ---------------------------------------------------------------------------
-- Inventory (Phase 6)
-- ---------------------------------------------------------------------------
CREATE TABLE suppliers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name        text NOT NULL,
    phone       text,
    notes       text,
    is_active   boolean NOT NULL DEFAULT true
);
CREATE INDEX idx_suppliers_location ON suppliers (location_id);

CREATE TABLE inventory_items (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name          text NOT NULL,
    sku           text,
    unit          text NOT NULL DEFAULT 'unit', -- kg, g, l, ml, unit, …
    reorder_level numeric(14, 3),
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_inventory_items_location ON inventory_items (location_id);

-- Recipe: how much of each inventory item one unit of a menu item consumes.
CREATE TABLE menu_item_ingredients (
    menu_item_id      uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    quantity          numeric(14, 3) NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (menu_item_id, inventory_item_id)
);

CREATE TABLE purchases (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
    status      purchase_status NOT NULL DEFAULT 'draft',
    total       bigint NOT NULL DEFAULT 0, -- Rial
    note        text,
    ordered_at  timestamptz,
    received_at timestamptz,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_purchases_location ON purchases (location_id);

CREATE TABLE purchase_items (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_id       uuid NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    quantity          numeric(14, 3) NOT NULL CHECK (quantity > 0),
    unit_cost         bigint NOT NULL DEFAULT 0 -- Rial per unit
);
CREATE INDEX idx_purchase_items_purchase ON purchase_items (purchase_id);

-- Append-only stock ledger. Current stock = SUM(quantity) per item.
CREATE TABLE stock_movements (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    type              stock_movement_type NOT NULL,
    quantity          numeric(14, 3) NOT NULL, -- signed: purchases +, sales/waste -
    unit_cost         bigint,                  -- Rial, for purchase/adjustment
    source_type       text,                    -- 'order' | 'purchase' | …
    source_id         uuid,
    note              text,
    created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    occurred_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_movements_item_time ON stock_movements (inventory_item_id, occurred_at);
CREATE INDEX idx_stock_movements_location_time ON stock_movements (location_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Double-entry ledger (Phase 7)
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    parent_id   uuid REFERENCES accounts(id) ON DELETE SET NULL,
    code        text NOT NULL,
    name        text NOT NULL,
    type        account_type NOT NULL,
    is_active   boolean NOT NULL DEFAULT true,
    UNIQUE (business_id, code)
);
CREATE INDEX idx_accounts_business ON accounts (business_id);

CREATE TABLE journal_entries (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
    entry_date  date NOT NULL,
    memo        text,
    source_type text,  -- 'order' | 'purchase' | 'manual' | …
    source_id   uuid,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    posted_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_journal_entries_business_date ON journal_entries (business_id, entry_date);

-- Each line is a debit XOR a credit. Entry balance (sum debit = sum credit)
-- is enforced by the posting service in the app layer (Phase 7).
CREATE TABLE journal_lines (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entry_id   uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    debit      bigint NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit     bigint NOT NULL DEFAULT 0 CHECK (credit >= 0),
    CONSTRAINT journal_lines_debit_xor_credit
        CHECK ((debit = 0) <> (credit = 0))
);
CREATE INDEX idx_journal_lines_entry ON journal_lines (entry_id);
CREATE INDEX idx_journal_lines_account ON journal_lines (account_id);

-- ---------------------------------------------------------------------------
-- Delivery (Phase 10)
-- ---------------------------------------------------------------------------
CREATE TABLE couriers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name        text NOT NULL,
    phone       text,
    is_active   boolean NOT NULL DEFAULT true
);
CREATE INDEX idx_couriers_location ON couriers (location_id);

CREATE TABLE deliveries (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    order_id     uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
    courier_id   uuid REFERENCES couriers(id) ON DELETE SET NULL,
    status       delivery_status NOT NULL DEFAULT 'pending',
    address      text NOT NULL,
    phone        text,
    fee          bigint NOT NULL DEFAULT 0, -- Rial
    dispatched_at timestamptz,
    delivered_at  timestamptz,
    note         text
);
CREATE INDEX idx_deliveries_location_status ON deliveries (location_id, status);
