-- ============================================================================
-- 0125_field_encryption_columns.sql — Phase 24 Wave 3: field-level encryption
-- at rest, step 1 of 3 (forward-only).
--
-- Step 1 (this migration): add nullable `*_enc bytea` twins — and `*_bidx text`
--   where equality lookup has to keep working — alongside the existing
--   plaintext columns. Nothing is encrypted here.
-- Step 2: `npm run db:encrypt-fields` (scripts/encrypt-fields.ts) backfills the
--   twins in batches under each business's own key. Idempotent and resumable
--   on `WHERE col_enc IS NULL`; reads during the window prefer `_enc` and fall
--   back to plaintext.
-- Step 3, one release later: drop the plaintext columns.
--
-- Encryption itself is deliberately NOT done in SQL. `pgcrypto`/`pgp_sym_encrypt`
-- would put the key in a query parameter — landing it in server logs,
-- pg_stat_statements and the WAL — and would decrypt on the database server,
-- the exact machine the threat model (adversary A4) assumes is owned. The key
-- never enters Postgres; the application encrypts and decrypts in its own
-- process (src/lib/field-crypto.ts).
--
-- The rule for what belongs here: encrypt a column only if it is never used in
-- a WHERE range, an ORDER BY, a GROUP BY or an aggregate. Equality-only lookup
-- is allowed via a blind index. Every money bigint, every timestamp, every
-- foreign key, orders.*, the journal, roles, statuses and users.full_name stay
-- plaintext — encrypting any of them breaks the ledger and the reports.
--
-- Interaction with RLS: none, by construction. `business_id` stays plaintext,
-- so every policy in 0021 is unaffected.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- customers — Tier B PII
--
-- `phone` keeps a blind index because it is the lookup at the till: an HMAC
-- of the canonical +98… number under a subkey derived from the business's own
-- DEK, so `WHERE phone_bidx = $1` is an indexed exact match against a column
-- nobody can read. The cost, stated plainly because it is a real regression
-- and not a detail: **partial and prefix phone search stops working** once the
-- plaintext column is dropped in step 3. src/lib/customers-service.ts's
-- `phone ILIKE '%term%'` in searchCustomers/listCustomers is what pays for it;
-- the exact-match path is added now and the substring path survives only as
-- long as the plaintext column does.
--
-- `phone_bidx` is also the designated replacement for `phone_e164`'s equality
-- work (0118's duplicate detection and segment resolution) — same
-- canonicalisation, deliberately — so step 3 must move those joins over rather
-- than leave a plaintext canonical phone behind, which would make encrypting
-- `phone` theatre.
--
-- `phone_last4` is a deliberate, decided exception: the last four digits, in
-- the clear, indexed.
--
-- The choice it settles: a blind index supports equality and nothing else, so
-- encrypting `phone` ends substring search on it. Two of the things people
-- type into the customer picker are a name (unaffected — `name` is Tier C and
-- stays plaintext) and the last four digits of a number they are reading off
-- a receipt or hearing on the phone. The second is the actual workflow at a
-- till, and losing it silently is the kind of regression that gets noticed in
-- production three weeks after the release that caused it.
--
-- What it costs: a dump leaks four digits per customer beside a name that was
-- already plaintext. Four digits cannot be dialled, cannot be messaged, and
-- leave on the order of a hundred thousand candidates for the full number, so
-- the mass-contactable PII this wave exists to protect stays protected.
--
-- What is NOT preserved, and is accepted as lost: arbitrary substring and
-- *prefix* search. `0912…` matches half an Iranian customer base and is worth
-- nothing as a search; a middle-of-the-number substring is rare enough that
-- the honest answer is to type the last four instead.
--
-- It is maintained like every other derived column here — written by the
-- service, invalidated by the trigger below when an unaware writer touches
-- the plaintext, and repaired by the backfill — rather than computed in SQL,
-- because the digits have to be folded from Persian numerals first
-- (`phoneDigits` in src/lib/phone.ts) and a `regexp_replace` on `\D` would
-- silently disagree with the application on exactly those rows.
--
-- `phone_kind` is the second plaintext remnant, and it fixes a bug rather than
-- preserving a feature. The CRM's «قابل پیامک» / with-mobile statistics count
-- `phone_e164 IS NOT NULL`, which means "parses as an Iranian number" — a
-- landline included. That was already wrong; it becomes *invisibly* wrong at
-- step 3, because a landline gets a blind index exactly like a mobile does, so
-- `phone_bidx IS NOT NULL` would keep counting front desks as SMS-reachable
-- with no column left to tell them apart. Storing `phone.ts`'s own
-- classification — the same `kind` `isMobilePhone()` already computes on every
-- write — answers "can this number receive an SMS" without decrypting
-- anything. It is a policy classification, not PII: it says what sort of line
-- this is, never whose.
-- ---------------------------------------------------------------------------
ALTER TABLE customers
    ADD COLUMN phone_enc   bytea,
    ADD COLUMN phone_bidx  text,
    ADD COLUMN phone_last4 text,
    ADD COLUMN phone_kind  text CHECK (phone_kind IN ('mobile', 'landline', 'unknown')),
    ADD COLUMN address_enc bytea,
    ADD COLUMN notes_enc   bytea;

CREATE INDEX idx_customers_phone_bidx ON customers (business_id, phone_bidx)
    WHERE phone_bidx IS NOT NULL;
CREATE INDEX idx_customers_phone_last4 ON customers (business_id, phone_last4)
    WHERE phone_last4 IS NOT NULL;

-- ---------------------------------------------------------------------------
-- reservations — the walk-in's callback number.
--
-- Scoped by location_id (0021 Shape 2), not business_id, so the blind index is
-- indexed on location_id; the HMAC key is still the business's DEK, since a
-- key per branch would mean the same customer hashing differently at two
-- branches of one business.
-- ---------------------------------------------------------------------------
ALTER TABLE reservations
    ADD COLUMN customer_phone_enc  bytea,
    ADD COLUMN customer_phone_bidx text;

CREATE INDEX idx_reservations_phone_bidx ON reservations (location_id, customer_phone_bidx)
    WHERE customer_phone_bidx IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The one real hazard of a dual-write window: a writer that updates the
-- plaintext column and not its ciphertext twin. The row then reads back as the
-- *old* value, because readers prefer `_enc` — a silent wrong answer, which is
-- worse than an unencrypted one.
--
-- `customers` and `reservations` are written from more places than the two
-- services this wave touches (crm-service's merge and phone normalisation, the
-- Holoo import, the integrations sync). Rather than chase every one of them
-- and hope the next one remembers, the invariant is enforced in the database:
-- change the plaintext without changing the ciphertext in the same statement
-- and the ciphertext is discarded. Reads then fall back to the plaintext,
-- which is correct-but-unencrypted, and the next `npm run db:encrypt-fields`
-- picks the row up again — it is resumable on exactly `WHERE col_enc IS NULL`.
--
-- This is the one piece of encryption logic that lives in SQL, and it holds no
-- key: it only invalidates.
-- ---------------------------------------------------------------------------
CREATE FUNCTION customers_invalidate_stale_ciphertext() RETURNS trigger AS $$
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
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customers_invalidate_stale_ciphertext
    BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION customers_invalidate_stale_ciphertext();

CREATE FUNCTION reservations_invalidate_stale_ciphertext() RETURNS trigger AS $$
BEGIN
    IF NEW.customer_phone IS DISTINCT FROM OLD.customer_phone
       AND NEW.customer_phone_enc IS NOT DISTINCT FROM OLD.customer_phone_enc THEN
        NEW.customer_phone_enc := NULL;
        NEW.customer_phone_bidx := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reservations_invalidate_stale_ciphertext
    BEFORE UPDATE ON reservations
    FOR EACH ROW EXECUTE FUNCTION reservations_invalidate_stale_ciphertext();

-- ---------------------------------------------------------------------------
-- business_encryption_keys (created by 0072_field_encryption.sql) gets the
-- uniqueness the mint path relies on. `getBusinessDek` inserts with
-- ON CONFLICT (business_id) DO NOTHING and re-reads, so that two concurrent
-- first-writes for a new business adopt one key instead of the loser
-- overwriting the winner's — which would orphan whatever the winner had
-- already encrypted. business_id is already the primary key there; this is a
-- no-op assertion of that fact for any install whose 0072 predates it.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'business_encryption_keys'::regclass
           AND contype IN ('p', 'u')
    ) THEN
        ALTER TABLE business_encryption_keys ADD PRIMARY KEY (business_id);
    END IF;
END $$;
