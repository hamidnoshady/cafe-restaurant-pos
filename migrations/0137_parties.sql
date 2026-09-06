-- ============================================================================
-- 0137_parties.sql — the customer record becomes the *party* record.
--
-- «مشتریان» was a section that could only hold customers, so every other kind of
-- counterparty grew its own private copy of the same facts: suppliers lived in
-- `suppliers` (name, phone, notes — and, because a branch keeps its own list, a
-- supplier could be three different people in one business), personnel lived in
-- `users` + `employees`, and the numbers that make either of them settleable
-- (کد ملی, کد اقتصادی, کد حسابداری, نرخ مالیات, a bank account) lived nowhere at
-- all. That is why three apps each had their own «افزودن/ویرایش» form and none of
-- them agreed with the others.
--
-- This migration makes the accounting word the data's word. `parties` — طرف‌حساب
-- — is the one table for customer, employee and supplier; `role` says which, and
-- everything else is shared. It is a *rename and extend*, not a new table, for
-- the reason 0118 gave for putting CRM columns on `customers` instead of beside
-- them: orders, reservations, AR receipts, loyalty points, table sessions,
-- payments, the assistant's RAG index and the Holoo importer all already point at
-- `customers(id)`. Renaming the table keeps every one of those foreign keys —
-- Postgres tracks them by OID — so the relations survive the rename *in data*,
-- which is exactly what "one record, many screens" needs. The screens are
-- re-pointed in the accompanying app changes; nothing here breaks them.
--
-- Four things happen:
--
--   1. `customers` → `parties`, indexes and trigger renamed with it (policies and
--      inbound FKs follow the table by OID and need nothing).
--   2. The party's own fields: role, person type, the accounting code (with who
--      decides it — `accounting_code_mode`), an avatar, the name split into
--      display/first/last, a category, and the four tab documents.
--   3. `party_categories` — the reference table `category_id` points at. Kept
--      separate rather than a CHECK over a fixed list because an owner groups
--      counterparties in their own words («خرده‌فروش», «پیمانکار», «رسومی»), and a
--      new group is data, not a migration.
--   4. Backfill: every existing customer is a customer party; every membership
--      becomes an employee party; every inventory supplier becomes a supplier
--      party that its `suppliers` rows now point at. Accounting codes are
--      assigned per business and role from the prefix scheme in
--      src/lib/parties.ts (۱ customer, ۲ supplier, ۳ personnel), so no business
--      is left with a party that cannot be found in its own ledger.
--
-- `parties.name` stays the physical display-name column while the API calls it
-- `displayName`; src/lib/parties.ts says why renaming eighty queries' worth of
-- `c.name` bought nothing a one-line mapper does not. No compatibility view named
-- `customers` is created: two names for one table, one of them writeable only by
-- convention, is how drift starts. Every reader is re-pointed in this change.
--
-- Tenant RLS on the one new table, in this migration, per CLAUDE.md.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The table follows the concept
-- ---------------------------------------------------------------------------
ALTER TABLE customers RENAME TO parties;

ALTER INDEX IF EXISTS idx_customers_business     RENAME TO idx_parties_business;
ALTER INDEX IF EXISTS idx_customers_phone        RENAME TO idx_parties_phone;
ALTER INDEX IF EXISTS idx_customers_phone_e164   RENAME TO idx_parties_phone_e164;
ALTER INDEX IF EXISTS idx_customers_phone_bidx   RENAME TO idx_parties_phone_bidx;
ALTER INDEX IF EXISTS idx_customers_phone_last4  RENAME TO idx_parties_phone_last4;
ALTER INDEX IF EXISTS idx_customers_lifecycle    RENAME TO idx_parties_lifecycle;
ALTER INDEX IF EXISTS idx_customers_email_lower  RENAME TO idx_parties_email_lower;
ALTER INDEX IF EXISTS idx_customers_merged_into  RENAME TO idx_parties_merged_into;
ALTER TRIGGER trg_customers_invalidate_stale_ciphertext ON parties
    RENAME TO trg_parties_invalidate_stale_ciphertext;

-- ---------------------------------------------------------------------------
-- 2. party_categories — what `category_id` refers to
-- ---------------------------------------------------------------------------
-- `role` narrows a category to one kind of counterparty (a "خرده‌فروش" group is
-- meaningless for personnel) and NULL means it applies to all three.
CREATE TABLE party_categories (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name        text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
    role        text CHECK (role IS NULL OR role IN ('customer', 'employee', 'supplier')),
    sort_order  integer NOT NULL DEFAULT 0,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Case- and space-insensitive: «معلم» and «معلم » are one category, and two of
-- them is exactly the bug the CRM's duplicates screen exists to clean. A unique
-- *expression* index rather than a table constraint, because `UNIQUE (lower(...))`
-- is not something a CREATE TABLE accepts.
CREATE UNIQUE INDEX idx_party_categories_business_name
    ON party_categories (business_id, lower(trim(name)));
CREATE INDEX idx_party_categories_business ON party_categories (business_id, sort_order);

ALTER TABLE party_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON party_categories FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 3. The party's own fields
-- ---------------------------------------------------------------------------
-- Every column arrives with its default already applied, so the ADDs below are
-- metadata-only against the existing rows; the backfills in step 4 are where data
-- moves.
ALTER TABLE parties
    -- Who this party is *to this business*. Lowercase, the column dialect; the
    -- API speaks 'Customer' | 'Employee' | 'Supplier' and maps in src/lib/parties.ts.
    ADD COLUMN role text NOT NULL DEFAULT 'customer'
                   CHECK (role IN ('customer', 'employee', 'supplier')),
    -- Real vs. legal person: the switch that decides whether a کد ملی or a
    -- company registration identifies this party, and therefore what the form
    -- asks for.
    ADD COLUMN person_type text NOT NULL DEFAULT 'real'
                          CHECK (person_type IN ('real', 'legal')),
    -- The ledger's number for this party. Set by hand when the business already
    -- numbers its counterparties (a migrated chart of accounts, a Holoo import),
    -- generated by the backend otherwise — which is what the mode column is for,
    -- and why the code itself stays nullable: 'automatic' + NULL means "not
    -- submitted yet", not "missing".
    ADD COLUMN accounting_code text
        CHECK (accounting_code IS NULL OR char_length(trim(accounting_code)) BETWEEN 1 AND 24),
    ADD COLUMN accounting_code_mode text NOT NULL DEFAULT 'automatic'
                                    CHECK (accounting_code_mode IN ('automatic', 'manual')),
    -- An avatar: a data URL or a URL, capped so a pasted scan cannot become a row.
    ADD COLUMN profile_image text
        CHECK (profile_image IS NULL OR char_length(profile_image) <= 400000),
    ADD COLUMN first_name text CHECK (first_name IS NULL OR char_length(first_name) <= 100),
    ADD COLUMN last_name  text CHECK (last_name  IS NULL OR char_length(last_name)  <= 100),
    -- The tab documents. Stored as sent (camelCase keys), because they are
    -- documents rather than columns: a future tab adds a key, not a migration.
    -- `general_info` holds nationalId / economicCode / taxPercentage; the other
    -- three are the placeholders their tabs will fill.
    ADD COLUMN general_info   jsonb NOT NULL DEFAULT '{}'::jsonb
                              CHECK (jsonb_typeof(general_info) = 'object'),
    ADD COLUMN address_info   jsonb NOT NULL DEFAULT '{}'::jsonb
                              CHECK (jsonb_typeof(address_info) = 'object'),
    ADD COLUMN contact_info   jsonb NOT NULL DEFAULT '{}'::jsonb
                              CHECK (jsonb_typeof(contact_info) = 'object'),
    ADD COLUMN financial_info jsonb NOT NULL DEFAULT '{}'::jsonb
                              CHECK (jsonb_typeof(financial_info) = 'object'),
    -- A personnel party IS a membership; the link is what lets the Team tab edit
    -- the person and the profile in one place instead of two.
    ADD COLUMN employee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN category_id uuid REFERENCES party_categories(id) ON DELETE SET NULL;

-- `status` is the existing `is_active` column (0039): one boolean, one meaning,
-- no second flag to disagree with it.

-- A party in manual mode without a number is not a party the ledger can post to.
ALTER TABLE parties
    ADD CONSTRAINT parties_manual_code_required
    CHECK (accounting_code_mode <> 'manual' OR accounting_code IS NOT NULL);

-- One membership, one personnel file — the idempotency handle the backfill and
-- «افزودن کارمند» both rely on.
CREATE UNIQUE INDEX idx_parties_employee_user
    ON parties (business_id, employee_user_id) WHERE employee_user_id IS NOT NULL;
-- Accounting codes are unique per business, across all three roles: the role
-- prefix makes collisions impossible by construction, and a DB-level promise beats
-- a convention the importer could forget.
CREATE UNIQUE INDEX idx_parties_accounting_code
    ON parties (business_id, accounting_code) WHERE accounting_code IS NOT NULL;
CREATE INDEX idx_parties_business_role
    ON parties (business_id, role) WHERE is_active;
CREATE INDEX idx_parties_category ON parties (category_id) WHERE category_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3b. The identity numbers are columns, not jsonb
--
-- `general_info` is the tab *document* the UI round-trips; the two numbers that
-- identify a party to the state are physical columns because that is what this
-- platform's machinery can act on: an envelope to seal (0125's `*_enc` twins), a
-- blind index to look one up without reading any (`*_bidx`), and a trigger that
-- drops the ciphertext the moment its plaintext moves. A key inside a jsonb blob
-- gets none of those — an owner could not search by کد ملی and the field-encryption
-- backfill could not reach it.
--
-- So: the wire shape stays nested exactly as the tab is drawn, and the service
-- splits it at the boundary. `taxPercentage` and everything a future tab adds stay
-- in the document, where an unknown key is a feature.
-- ---------------------------------------------------------------------------
ALTER TABLE parties
    ADD COLUMN national_id text,
    ADD COLUMN national_id_enc bytea,
    ADD COLUMN national_id_bidx text,
    ADD COLUMN economic_code text,
    ADD COLUMN economic_code_enc bytea;
CREATE INDEX idx_parties_national_id_bidx
    ON parties (business_id, national_id_bidx) WHERE national_id_bidx IS NOT NULL;

-- The 0125 trigger, widened to the two new pairs. Replaced rather than added to:
-- one BEFORE UPDATE pass per table, so a future reader finds the rule in exactly
-- one place. Deliberately *not* a unique index on the number itself — a database
-- that already holds the same کد ملی twice (an import, a merge that never ran)
-- would refuse to migrate, and an install's history is not this migration's to
-- rewrite. Duplicate detection stays the service's job, where the answer can be a
-- message instead of a failed upgrade.
CREATE FUNCTION parties_invalidate_stale_ciphertext() RETURNS trigger AS $$
BEGIN
    IF NEW.phone IS DISTINCT FROM OLD.phone AND NEW.phone_enc IS NOT DISTINCT FROM OLD.phone_enc THEN
        NEW.phone_enc := NULL;
        NEW.phone_bidx := NULL;
        NEW.phone_last4 := NULL;
        NEW.phone_kind := NULL;
    END IF;
    IF NEW.address IS DISTINCT FROM OLD.address AND NEW.address_enc IS NOT DISTINCT FROM OLD.address_enc THEN
        NEW.address_enc := NULL;
    END IF;
    IF NEW.notes IS DISTINCT FROM OLD.notes AND NEW.notes_enc IS NOT DISTINCT FROM OLD.notes_enc THEN
        NEW.notes_enc := NULL;
    END IF;
    IF NEW.national_id IS DISTINCT FROM OLD.national_id
       AND NEW.national_id_enc IS NOT DISTINCT FROM OLD.national_id_enc THEN
        NEW.national_id_enc := NULL;
        NEW.national_id_bidx := NULL;
    END IF;
    IF NEW.economic_code IS DISTINCT FROM OLD.economic_code
       AND NEW.economic_code_enc IS NOT DISTINCT FROM OLD.economic_code_enc THEN
        NEW.economic_code_enc := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER trg_parties_invalidate_stale_ciphertext ON parties;
CREATE TRIGGER trg_parties_invalidate_stale_ciphertext
    BEFORE UPDATE ON parties
    FOR EACH ROW EXECUTE FUNCTION parties_invalidate_stale_ciphertext();

-- ---------------------------------------------------------------------------
-- 4. Backfill
-- ---------------------------------------------------------------------------

-- 4a. The tax rate every existing party is assumed to carry. Explicit rather
-- than left NULL so `parties.general_info` answers the same question for a 2019
-- row and for one created this minute; the ledger's *posting* rate still comes
-- from the branch's own configuration (src/lib/tax-*.ts) — a per-party rate is
-- metadata the VAT report can consult, and nothing yet does.
UPDATE parties
   SET general_info = general_info || jsonb_build_object('taxPercentage', 9)
 WHERE NOT general_info ? 'taxPercentage';

-- 4b. Personnel. One party per membership, with whatever the employee profile
-- already knows. `users` rather than `employees`: the latter is created lazily
-- (0042), and a cashier who has never clocked in is still a طرف‌حساب.
INSERT INTO parties (
    business_id, name, first_name, phone, email, is_active,
    role, person_type, employee_user_id, created_at
)
SELECT
    u.business_id,
    u.full_name,
    NULLIF(trim(split_part(u.full_name, ' ', 1)), ''),
    e.phone,
    u.email::text,
    u.is_active,
    'employee',
    'real',
    u.id,
    u.created_at
FROM users u
LEFT JOIN employees e ON e.id = u.id
WHERE NOT EXISTS (
    SELECT 1 FROM parties p
     WHERE p.business_id = u.business_id AND p.employee_user_id = u.id
);

-- 4c. Suppliers. `suppliers` is location-scoped (0001 predates the business-wide
-- customer), so one business can hold the same supplier four times. The party is
-- the business-wide half — one per (business, name) — and every `suppliers` row
-- keeps working as the per-branch alias it has always been.
ALTER TABLE suppliers
    ADD COLUMN party_id uuid REFERENCES parties(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_suppliers_location_party
    ON suppliers (location_id, party_id) WHERE party_id IS NOT NULL;

-- One party per (business, name), taking the contact details from the oldest row
-- of that name. A supplier with no documents on file is treated as a legal person,
-- which is the case that has a registration number rather than a کد ملی —
-- conservative in the direction that asks the owner for the missing identity
-- rather than inventing one.
INSERT INTO parties (business_id, name, phone, notes, role, person_type)
SELECT business_id, name, phone, notes, 'supplier', 'legal'
FROM (
    SELECT DISTINCT ON (l.business_id, lower(trim(s.name)))
           l.business_id,
           trim(s.name) AS name,
           s.phone,
           s.notes
      FROM suppliers s
      JOIN locations l ON l.id = s.location_id
     ORDER BY l.business_id, lower(trim(s.name)), s.name
) seed
ON CONFLICT DO NOTHING;

UPDATE suppliers s
   SET party_id = p.id
  FROM parties p
  JOIN locations l ON l.business_id = p.business_id
 WHERE s.party_id IS NULL
   AND p.role = 'supplier'
   AND s.location_id = l.id
   AND lower(trim(s.name)) = lower(trim(p.name));

-- 4d. Accounting codes, per business and role, oldest party first — the same
-- `nextAccountingCode` the service uses, run once over history.
WITH numbered AS (
    SELECT id, role,
           row_number() OVER (PARTITION BY business_id, role ORDER BY created_at, id) AS seq
      FROM parties
     WHERE accounting_code IS NULL
)
UPDATE parties p
   SET accounting_code = CASE n.role
                             WHEN 'customer' THEN '1'
                             WHEN 'supplier' THEN '2'
                             ELSE '3'
                         END || lpad(n.seq::text, 5, '0'),
       -- Whatever the number came from is now settled, and the mode records that
       -- the *system* decided it — which is the answer to "may I change this?".
       accounting_code_mode = 'automatic'
  FROM numbered n
 WHERE n.id = p.id
   -- A duplicate name inside one business is possible; the code is not allowed to
   -- collide, so the sequence is only assigned where the generated value is free.
   AND NOT EXISTS (
       SELECT 1 FROM parties other
        WHERE other.business_id = p.business_id
          AND other.accounting_code =
              CASE n.role WHEN 'customer' THEN '1' WHEN 'supplier' THEN '2' ELSE '3' END
              || lpad(n.seq::text, 5, '0')
   );

-- ---------------------------------------------------------------------------
-- 5. The permission names follow the record
-- ---------------------------------------------------------------------------
-- `customers.view` / `customers.manage` become `parties.view` / `parties.manage`.
-- A role's preset is computed in code, but the *per-member overrides* are stored
-- as jsonb arrays of these very strings, in two tables (`users` and the pending
-- `invitations` rows). Left alone, an override
-- would stop naming any real permission — which for `revoked` is not harmless: a
-- revocation that no longer matches reads as a grant nobody revoked. Rewritten
-- here, in the migration that renames the thing, so no window exists where the two
-- disagree.
--
-- The mapping is only ever `customers.* → parties.*`; every other permission is
-- passed through untouched, so a business that also revoked `ledger.post` keeps
-- exactly that. Both helpers are dropped afterwards: they exist for this statement,
-- and a permanent SQL function named after one rename invites the next rename to
-- forget it.
CREATE FUNCTION parties_map_permission(permission text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE permission
           WHEN 'customers.view'   THEN 'parties.view'
           WHEN 'customers.manage' THEN 'parties.manage'
           ELSE permission
         END;
$$;

CREATE FUNCTION parties_map_permissions(permissions jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT (
    SELECT coalesce(jsonb_object_agg(key,
      CASE WHEN jsonb_typeof(value) = 'array'
           THEN (SELECT coalesce(jsonb_agg(parties_map_permission(elem #>> '{}')), '[]'::jsonb)
                   FROM jsonb_array_elements(value) AS elem)
           ELSE value END), '{}'::jsonb)
      FROM jsonb_each(permissions)
  );
$$;

UPDATE users
   SET permissions = parties_map_permissions(permissions)
 WHERE permissions <> '{}'::jsonb;

UPDATE invitations
   SET permissions = parties_map_permissions(permissions)
 WHERE permissions <> '{}'::jsonb;

DROP FUNCTION parties_map_permissions(jsonb);
DROP FUNCTION parties_map_permission(text);
