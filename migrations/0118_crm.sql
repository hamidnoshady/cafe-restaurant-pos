-- ============================================================================
-- 0118_crm.sql — the CRM app («مشتریان»), the platform's third app.
--
-- What already existed, and why this migration is smaller than it looks:
-- `customers` has carried email, birthday, tags and the two consent flags
-- since 0081, `customer_points` is the loyalty ledger, `orders`/`payments`
-- hold the purchase history, `reservations` the bookings and `repair_tickets`
-- the watch/jewellery repairs. The customer *model* is therefore not rebuilt
-- here. What was missing was everything that lets an owner **name a group,
-- read one person's whole history, and record what was said to them** — plus
-- the objects a sale that takes more than one conversation needs.
--
-- Seven tables, and the reason each one has to exist rather than being derived:
--
--   customer_segments      a rule document with a name. Dynamic by design: a
--                          segment is a definition resolved at use time, not a
--                          frozen list, because a list is wrong the next time
--                          somebody buys something.
--   customer_notes         free text about a person. The only part of the
--                          timeline that has nowhere else to live.
--   crm_activities         calls, meetings, visits and tasks. A commitment
--                          ("ring them Thursday") has no home in a POS at all.
--   crm_deals              the multi-conversation sale — a catering contract, a
--                          custom ring. Deliberately NOT a revenue document:
--                          see the note on the table.
--   crm_cases              complaints and requests that need resolving, with a
--                          response-time target per priority.
--   crm_consent_events     the audit trail for consent. A checkbox records the
--                          current answer; only an event log can prove who
--                          changed it, when, and on whose say-so.
--   crm_merges             what was merged into what. A merge is irreversible,
--                          so the record of it is the only way to explain a
--                          customer file's history afterwards.
--
-- Deliberately absent: a timeline/event table. The timeline is a *mapping*
-- over the tables that already own each fact, assembled in
-- `customer-timeline-service.ts`. A copy would be a second source of truth
-- that falls behind the first, and does so silently.
--
-- Also absent: any account, journal line or posting rule. This app writes no
-- money. A won deal records no revenue — the sale is posted when an order or
-- invoice settles through the existing path, which already posts correctly.
-- Two paths to the same revenue is the one thing the accounting rules in
-- CLAUDE.md never permit.
--
-- Every table here is tenant-scoped and gets its RLS policy in this same
-- migration (the repo's standing rule; integration/tenant-isolation asserts
-- it over the live schema, so a missing policy fails the suite rather than
-- leaking in production).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Segments — a named rule document
-- ---------------------------------------------------------------------------
CREATE TABLE customer_segments (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (btrim(name) <> ''),
    description  text NOT NULL DEFAULT '',
    -- The rule document compiled by src/lib/segments.ts. jsonb, not text: the
    -- shape is queried and validated, never string-matched.
    definition   jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- A segment the app itself proposes (the RFM lifecycle stages) versus one
    -- the owner wrote. Built-ins can be re-seeded; a user's own is never
    -- touched by a later migration.
    is_builtin   boolean NOT NULL DEFAULT false,
    -- Archive rather than delete: a segment may be referenced by a campaign
    -- that has already been sent, and its name must stay resolvable.
    archived_at  timestamptz,
    created_by   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, name)
);
CREATE INDEX idx_customer_segments_business ON customer_segments (business_id)
    WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- Notes
-- ---------------------------------------------------------------------------
CREATE TABLE customer_notes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- CASCADE, unlike customer_points' RESTRICT: a note carries no financial
    -- history, so it must not be the reason a customer cannot be removed.
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    body        text NOT NULL CHECK (btrim(body) <> ''),
    /* Pinned notes lead the file — «آلرژی به بادام» must not scroll away. */
    is_pinned   boolean NOT NULL DEFAULT false,
    created_by  text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customer_notes_customer ON customer_notes (business_id, customer_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Activities — what happened, and what was promised
-- ---------------------------------------------------------------------------
CREATE TABLE crm_activities (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Nullable: an activity may hang off a deal that has no customer record yet
    -- (an enquiry from a company that has never bought).
    customer_id  uuid REFERENCES customers(id) ON DELETE CASCADE,
    deal_id      uuid,  -- FK added after crm_deals exists
    case_id      uuid,  -- FK added after crm_cases exists
    kind         text NOT NULL CHECK (kind IN ('call', 'meeting', 'message', 'note', 'task', 'visit')),
    subject      text NOT NULL CHECK (btrim(subject) <> ''),
    body         text NOT NULL DEFAULT '',
    -- A future due_at with no completed_at IS the task model. One table for
    -- "what happened" and "what must happen" — the two are the same row at
    -- different times, and splitting them would double every list and filter.
    due_at       timestamptz,
    completed_at timestamptz,
    -- Who owes the follow-up. Text, matching created_by's convention here.
    assigned_to  text NOT NULL DEFAULT '',
    created_by   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_activities_customer ON crm_activities (business_id, customer_id, created_at DESC);
-- The "my open tasks" query: outstanding commitments, soonest first.
CREATE INDEX idx_crm_activities_open ON crm_activities (business_id, due_at)
    WHERE completed_at IS NULL AND due_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Deals — the multi-conversation sale
-- ---------------------------------------------------------------------------
--
-- Not a revenue document, and the schema says so out loud:
--   * `value_rial` is an *expected* amount an owner typed, never a posted one;
--   * there is no account, no journal line, no posting rule anywhere near it;
--   * `order_id` links a won deal to the sale that actually settled, so the
--     money is reported once, from the ledger, by the sale that posted it.
-- A pipeline that also booked revenue would be a second unreconciled source of
-- truth for the same money.
CREATE TABLE crm_deals (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id  uuid REFERENCES customers(id) ON DELETE SET NULL,
    title        text NOT NULL CHECK (btrim(title) <> ''),
    description  text NOT NULL DEFAULT '',
    stage        text NOT NULL DEFAULT 'lead'
                 CHECK (stage IN ('lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
    -- Integer Rial, the repo-wide money convention (the UI takes Toman).
    value_rial   bigint NOT NULL DEFAULT 0 CHECK (value_rial >= 0),
    -- Null = use the stage's default from crm-shared.ts, so a business that
    -- never touches probabilities still gets a sensible weighted forecast.
    probability  integer CHECK (probability IS NULL OR (probability >= 0 AND probability <= 100)),
    expected_close_date date,
    owner_user   text NOT NULL DEFAULT '',
    source       text NOT NULL DEFAULT '',
    -- Set when the deal reaches a terminal stage; `lost_reason` is what makes
    -- the loss report worth reading.
    closed_at    timestamptz,
    lost_reason  text,
    -- The sale that actually settled, when there was one. This is the only
    -- link between the pipeline and money, and it points *at* the ledger's
    -- document rather than duplicating it.
    order_id     uuid REFERENCES orders(id) ON DELETE SET NULL,
    created_by   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_deals_business_stage ON crm_deals (business_id, stage);
CREATE INDEX idx_crm_deals_customer ON crm_deals (business_id, customer_id);

-- ---------------------------------------------------------------------------
-- Cases — complaints and requests
-- ---------------------------------------------------------------------------
CREATE TABLE crm_cases (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id  uuid REFERENCES customers(id) ON DELETE SET NULL,
    subject      text NOT NULL CHECK (btrim(subject) <> ''),
    body         text NOT NULL DEFAULT '',
    status       text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'in_progress', 'waiting', 'resolved', 'closed')),
    priority     text NOT NULL DEFAULT 'normal'
                 CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    -- Free text rather than an enum: what a café is complained to about and
    -- what a jeweller is has almost nothing in common, and an enum would be
    -- wrong for four of the five trades.
    category     text NOT NULL DEFAULT '',
    -- The order/invoice the complaint is about, when it is about one.
    order_id     uuid REFERENCES orders(id) ON DELETE SET NULL,
    assigned_to  text NOT NULL DEFAULT '',
    resolution   text NOT NULL DEFAULT '',
    opened_at    timestamptz NOT NULL DEFAULT now(),
    resolved_at  timestamptz,
    created_by   text NOT NULL DEFAULT '',
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_cases_business_status ON crm_cases (business_id, status, opened_at DESC);
CREATE INDEX idx_crm_cases_customer ON crm_cases (business_id, customer_id);

-- Now that both tables exist, close the activity links. Done here rather than
-- inline so the three tables can be read in dependency order above.
ALTER TABLE crm_activities
    ADD CONSTRAINT crm_activities_deal_fk FOREIGN KEY (deal_id) REFERENCES crm_deals(id) ON DELETE CASCADE,
    ADD CONSTRAINT crm_activities_case_fk FOREIGN KEY (case_id) REFERENCES crm_cases(id) ON DELETE CASCADE;
CREATE INDEX idx_crm_activities_deal ON crm_activities (deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX idx_crm_activities_case ON crm_activities (case_id) WHERE case_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Consent audit — the table the next phase depends on
-- ---------------------------------------------------------------------------
--
-- The messaging phase will send real SMS to real people. The only thing
-- standing between it and a complaint is `customers.sms_consent` — and a
-- boolean column can say what the answer is *now* but never who changed it or
-- when. «مشتری گفت دیگر نفرستید» has to be provable, so every change is
-- appended here, including the ones a merge causes.
--
-- Append-only by construction: there is no updated_at and nothing in the app
-- issues an UPDATE against it.
CREATE TABLE crm_consent_events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    channel      text NOT NULL CHECK (channel IN ('sms', 'email')),
    granted      boolean NOT NULL,
    source       text NOT NULL DEFAULT 'staff'
                 CHECK (source IN ('staff', 'customer_request', 'import', 'merge', 'signup')),
    note         text NOT NULL DEFAULT '',
    changed_by   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_consent_customer ON crm_consent_events (business_id, customer_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Merges
-- ---------------------------------------------------------------------------
--
-- A merge moves references and archives the losing record; it never deletes it
-- and never touches an accounting document. This table is what makes the
-- result explainable six months later, and what lets the customer file show
-- «این پرونده با پروندهٔ دیگری ادغام شده است».
CREATE TABLE crm_merges (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The record that survives.
    winner_id       uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    -- The record that was archived. RESTRICT: the loser must stay readable,
    -- because the merge record is meaningless without it.
    loser_id        uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    -- What actually moved: {"orders": 12, "payments": 8, ...}. A count, not a
    -- copy of the rows, so this table cannot drift from the data it describes.
    moved_counts    jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- The loser's own fields at merge time, so the merge is explainable even
    -- after later edits to the winner.
    loser_snapshot  jsonb NOT NULL DEFAULT '{}'::jsonb,
    merged_by       text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_merges_winner ON crm_merges (business_id, winner_id);
CREATE INDEX idx_crm_merges_loser ON crm_merges (business_id, loser_id);

-- ---------------------------------------------------------------------------
-- Customer columns the CRM adds
-- ---------------------------------------------------------------------------
--
-- On `customers` itself rather than in a side table: they are per-customer
-- facts read on every list and every segment resolution, and a join for a
-- boolean is a join for nothing. They inherit `customers`' existing RLS policy
-- (0021 Shape 1) — stated explicitly so the next reader does not look for a
-- policy that should not exist.
ALTER TABLE customers
    -- The canonical +98… form from src/lib/phone.ts. Segments, duplicate
    -- detection and (next phase) sending all key on this rather than on the
    -- typed string, because four spellings of one number are four customers to
    -- everything that compares text.
    ADD COLUMN phone_e164 text,
    -- Set when this record lost a merge; it stops appearing in pickers and its
    -- file points at the winner.
    ADD COLUMN merged_into_id uuid REFERENCES customers(id) ON DELETE SET NULL,
    -- Denormalised RFM, refreshed by the CRM's own recompute rather than on
    -- every order: scoring is a whole-population operation (quintiles are
    -- relative), so it cannot be maintained incrementally per sale. Null until
    -- the first recompute, and every screen treats null as "not yet scored"
    -- rather than as zero.
    ADD COLUMN rfm_recency integer,
    ADD COLUMN rfm_frequency integer,
    ADD COLUMN rfm_monetary integer,
    ADD COLUMN lifecycle_stage text,
    ADD COLUMN rfm_scored_at timestamptz;

-- Duplicate detection's index, and the lookup a later SMS send will do.
CREATE INDEX idx_customers_phone_e164 ON customers (business_id, phone_e164)
    WHERE phone_e164 IS NOT NULL;
CREATE INDEX idx_customers_lifecycle ON customers (business_id, lifecycle_stage)
    WHERE lifecycle_stage IS NOT NULL;
-- Case-insensitive email match for duplicate detection.
CREATE INDEX idx_customers_email_lower ON customers (business_id, lower(email))
    WHERE email IS NOT NULL;
CREATE INDEX idx_customers_merged_into ON customers (merged_into_id)
    WHERE merged_into_id IS NOT NULL;

-- Backfill the canonical phone for existing rows. Deliberately narrow: only
-- the unambiguous Iranian mobile shapes are converted, exactly matching
-- normalizePhone()'s mobile branch. Anything else stays null and is reported
-- by scripts/normalize-customer-phones.ts rather than being guessed at here,
-- because a wrong canonical number silently merges two real customers.
UPDATE customers
   SET phone_e164 = '+98' || right(regexp_replace(phone, '\D', '', 'g'), 10)
 WHERE phone IS NOT NULL
   AND phone_e164 IS NULL
   AND regexp_replace(phone, '\D', '', 'g') ~ '^(?:0|98|0098|\+98)?9\d{9}$';

-- ---------------------------------------------------------------------------
-- RLS — one policy per table, in this same migration
-- ---------------------------------------------------------------------------
ALTER TABLE customer_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_segments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_segments FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE customer_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_notes FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_activities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_activities FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_deals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_deals FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_cases FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_consent_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_consent_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_merges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_merges FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
