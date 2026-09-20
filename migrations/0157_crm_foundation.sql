-- ============================================================================
-- 0157_crm_foundation.sql — the CRM becomes a standard CRM.
--
-- Migration 0118 built the first CRM: segments, notes, activities, a fixed
-- six-stage pipeline, cases, consent events and merges. It was a good start
-- and every table it created survives here unchanged. What it did not have is
-- the spine a real business needs:
--
--   * a **lead** that exists before the person is a customer;
--   * a **configurable pipeline**, because a jeweller's stages are not a
--     caterer's;
--   * **stage history**, without which "how long do deals sit in Proposal?"
--     cannot be answered at all;
--   * **stable owner ids**, because `owner_user text` breaks the moment
--     somebody's display name is corrected;
--   * **relationships between parties**, so an organisation can have contacts
--     without those contacts becoming duplicate identity records;
--   * **typed custom fields**, so a business stores its own data without a
--     schema change;
--   * an **external customer profile**, which is the architectural fix: the
--     WooCommerce importer used to write canonical `parties` rows directly,
--     making Website Management a second writer of CRM's identity.
--
-- What this migration deliberately does NOT do:
--
--   * It creates no second customer table. `parties` stays canonical; every
--     new table points at it.
--   * It creates no account, journal line or posting rule. A deal remains a
--     forecast; revenue is still posted only by the sale that settles.
--   * It creates no campaign, message or website-content table. Growth and
--     Website Management keep those.
--   * It destroys nothing. Existing deals keep their stage *string*, and the
--     backfill below maps each one onto a seeded stage row of the same
--     meaning, so a business that upgrades sees exactly the pipeline it had.
--
-- Every tenant-scoped table below carries `business_id`, its foreign keys, its
-- indexes, and its RLS policy in this same migration — the repo's standing
-- rule, asserted over the live schema by integration/tenant-isolation.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Pipelines and stages — replacing the hardcoded six
-- ---------------------------------------------------------------------------
--
-- The old model was a CHECK constraint listing six strings. That is fine until
-- the first business says "we have a site-visit stage". Stages become rows;
-- the CHECK is dropped at the end of this file, after every existing deal has
-- been pointed at a seeded stage row.
CREATE TABLE crm_pipelines (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (btrim(name) <> ''),
    description  text NOT NULL DEFAULT '',
    -- Exactly one default per business, enforced by the partial unique index
    -- below. A deal created without a pipeline lands in it.
    is_default   boolean NOT NULL DEFAULT false,
    display_order integer NOT NULL DEFAULT 0,
    archived_at  timestamptz,
    created_by   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, name)
);
CREATE UNIQUE INDEX idx_crm_pipelines_one_default ON crm_pipelines (business_id)
    WHERE is_default AND archived_at IS NULL;
CREATE INDEX idx_crm_pipelines_business ON crm_pipelines (business_id, display_order)
    WHERE archived_at IS NULL;

CREATE TABLE crm_pipeline_stages (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    pipeline_id   uuid NOT NULL REFERENCES crm_pipelines(id) ON DELETE CASCADE,
    name          text NOT NULL CHECK (btrim(name) <> ''),
    -- The pre-0157 stage string this row stands for, where there is one.
    -- Populated only for the seeded default stages, and the reason an upgrade
    -- is lossless: every legacy `crm_deals.stage` value finds its row here.
    legacy_key    text,
    display_order integer NOT NULL DEFAULT 0,
    -- The forecast weight used when a deal does not override it.
    default_probability integer NOT NULL DEFAULT 0
        CHECK (default_probability >= 0 AND default_probability <= 100),
    -- Terminal classification. `open` stages are the pipeline; `won`/`lost`
    -- are the outcomes. Reporting keys on this rather than on a stage name, so
    -- a business renaming «برنده» to «قرارداد بسته شد» keeps its win rate.
    outcome       text NOT NULL DEFAULT 'open'
                  CHECK (outcome IN ('open', 'won', 'lost')),
    is_active     boolean NOT NULL DEFAULT true,
    -- A short note shown to the user: "what has to be true to move a deal
    -- here". Guidance, not an executable rule — an executable rule in a text
    -- column is an injection surface and a support burden.
    requirement_note text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (pipeline_id, name)
);
CREATE INDEX idx_crm_pipeline_stages_pipeline
    ON crm_pipeline_stages (business_id, pipeline_id, display_order);
CREATE INDEX idx_crm_pipeline_stages_legacy
    ON crm_pipeline_stages (business_id, legacy_key) WHERE legacy_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Deals: stable ownership, a pipeline, and the fields a forecast needs
-- ---------------------------------------------------------------------------
ALTER TABLE crm_deals
    ADD COLUMN pipeline_id uuid REFERENCES crm_pipelines(id) ON DELETE SET NULL,
    ADD COLUMN stage_id    uuid REFERENCES crm_pipeline_stages(id) ON DELETE SET NULL,
    -- A stable membership id. `owner_user text` is kept beside it, not
    -- dropped: it is the display-name snapshot for rows written before this
    -- migration and for audit history. New writes set both.
    ADD COLUMN owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN next_step   text NOT NULL DEFAULT '',
    ADD COLUMN won_reason  text,
    -- When the deal last entered its current stage — the basis of "stage age"
    -- and of the stale-deal report. Backfilled to `created_at` below.
    ADD COLUMN stage_entered_at timestamptz,
    ADD COLUMN last_activity_at timestamptz,
    ADD COLUMN tags        text[] NOT NULL DEFAULT '{}'::text[],
    -- Where this deal came from. Standardised vocabulary lives in
    -- src/lib/crm-sources.ts; the column stays text so an unrecognised value
    -- from an older row is readable rather than a constraint violation.
    ADD COLUMN source_detail text NOT NULL DEFAULT '',
    ADD COLUMN lead_id     uuid;

CREATE INDEX idx_crm_deals_pipeline ON crm_deals (business_id, pipeline_id, stage_id);
CREATE INDEX idx_crm_deals_owner ON crm_deals (business_id, owner_user_id)
    WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_crm_deals_stage_entered ON crm_deals (business_id, stage_entered_at DESC);

-- Stage history: from, to, when, by, and how long the deal sat in the stage it
-- left. Recorded as a row per transition rather than derived, because the
-- *sequence* is the thing reporting needs and a current-state column cannot
-- reconstruct it.
CREATE TABLE crm_deal_stage_history (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    deal_id        uuid NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
    from_stage_id  uuid REFERENCES crm_pipeline_stages(id) ON DELETE SET NULL,
    to_stage_id    uuid REFERENCES crm_pipeline_stages(id) ON DELETE SET NULL,
    -- Name snapshots, so history stays readable after a stage is renamed or
    -- archived. The ids above are for joins; these are for people.
    from_stage_name text NOT NULL DEFAULT '',
    to_stage_name   text NOT NULL DEFAULT '',
    -- Seconds the deal spent in `from_stage_id`. Stored rather than derived so
    -- a velocity report is a SUM and not a window function over every row.
    seconds_in_from_stage bigint,
    changed_by_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    changed_by     text NOT NULL DEFAULT '',
    note           text NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_deal_stage_history_deal
    ON crm_deal_stage_history (business_id, deal_id, created_at DESC);
CREATE INDEX idx_crm_deal_stage_history_stage
    ON crm_deal_stage_history (business_id, to_stage_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Leads — the record that exists before there is a customer
-- ---------------------------------------------------------------------------
--
-- A lead is deliberately NOT a party. Turning every enquiry into a canonical
-- customer record is how a CRM fills up with 4,000 people who never bought
-- anything and can never be cleaned out. A lead is converted *into* a party,
-- through the canonical party service, once it is worth being one.
CREATE TABLE crm_leads (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name          text NOT NULL CHECK (btrim(name) <> ''),
    organization  text NOT NULL DEFAULT '',
    phone         text,
    -- The canonical +98… form, derived by the service exactly as parties do,
    -- so lead-to-party dedupe compares like with like.
    phone_e164    text,
    email         text,
    -- Acquisition source. First source is never overwritten (see
    -- src/lib/crm-sources.ts); a later interaction updates the deal, not this.
    source        text NOT NULL DEFAULT 'manual',
    source_detail text NOT NULL DEFAULT '',
    -- UTM/campaign attribution when a website form carried it.
    utm           jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- The connection that delivered this lead (a Woo store, a CMS site), when
    -- one did. NULL for a lead typed by a person.
    connection_id uuid,
    external_ref  text,
    status        text NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'contacted', 'working', 'qualified', 'unqualified', 'converted')),
    rating        text NOT NULL DEFAULT 'warm'
                  CHECK (rating IN ('hot', 'warm', 'cold')),
    owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    owner_name    text NOT NULL DEFAULT '',
    notes         text NOT NULL DEFAULT '',
    next_action   text NOT NULL DEFAULT '',
    next_action_at timestamptz,
    qualification_reason   text NOT NULL DEFAULT '',
    disqualification_reason text NOT NULL DEFAULT '',
    last_activity_at timestamptz,
    -- Set by conversion. Both halves recorded: which party it became, and
    -- which deal (if any) was opened at the same time.
    converted_party_id uuid REFERENCES parties(id) ON DELETE SET NULL,
    converted_deal_id  uuid REFERENCES crm_deals(id) ON DELETE SET NULL,
    converted_at  timestamptz,
    converted_by  text NOT NULL DEFAULT '',
    created_by    text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_leads_status ON crm_leads (business_id, status, created_at DESC);
CREATE INDEX idx_crm_leads_owner ON crm_leads (business_id, owner_user_id, status)
    WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_crm_leads_phone ON crm_leads (business_id, phone_e164)
    WHERE phone_e164 IS NOT NULL;
CREATE INDEX idx_crm_leads_email ON crm_leads (business_id, lower(email))
    WHERE email IS NOT NULL;
-- The same external lead delivered twice must not become two leads.
CREATE UNIQUE INDEX idx_crm_leads_external
    ON crm_leads (business_id, connection_id, external_ref)
    WHERE connection_id IS NOT NULL AND external_ref IS NOT NULL;

ALTER TABLE crm_deals
    ADD CONSTRAINT crm_deals_lead_fk FOREIGN KEY (lead_id) REFERENCES crm_leads(id) ON DELETE SET NULL;
CREATE INDEX idx_crm_deals_lead ON crm_deals (lead_id) WHERE lead_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Party relationships — an organisation and its people
-- ---------------------------------------------------------------------------
--
-- Both ends are `parties`. A legal party is the organisation/account; a real
-- party is the individual. This is what lets a company have five contacts
-- without five duplicate identity records — the exact failure mode a second
-- "contacts" table would have created.
CREATE TABLE crm_party_relationships (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    from_party_id uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
    to_party_id   uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
    kind          text NOT NULL
                  CHECK (kind IN ('contact_of', 'decision_maker', 'billing_contact',
                                  'purchasing_contact', 'owner_of', 'household',
                                  'referred_by', 'parent_organization', 'branch_of')),
    role_title    text NOT NULL DEFAULT '',
    is_primary    boolean NOT NULL DEFAULT false,
    note          text NOT NULL DEFAULT '',
    created_by    text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    -- One edge of a given kind between two parties.
    UNIQUE (business_id, from_party_id, to_party_id, kind),
    -- A party is not its own contact.
    CONSTRAINT crm_party_relationships_not_self CHECK (from_party_id <> to_party_id)
);
CREATE INDEX idx_crm_party_rel_from ON crm_party_relationships (business_id, from_party_id, kind);
CREATE INDEX idx_crm_party_rel_to ON crm_party_relationships (business_id, to_party_id, kind);

-- ---------------------------------------------------------------------------
-- 5. External customer profiles — Website Management's mirror, CRM's mapping
-- ---------------------------------------------------------------------------
--
-- **The ownership fix.** `upsertCustomerFromWoo()` used to INSERT into
-- `parties` directly and resolve ambiguity with `ORDER BY created_at LIMIT 1`.
-- Two things were wrong with that: Website Management became a second writer
-- of CRM's canonical identity, and an ambiguous match (two live parties with
-- the same phone) silently picked the older one — which is a coin toss
-- presented as a fact.
--
-- The shape below separates the three concerns that were tangled together:
--
--   1. the **remote snapshot** — what the store says, with provenance;
--   2. the **mapping** — which canonical party this remote identity is, with a
--      status and a confidence;
--   3. the **conflict** — where the remote value and the local value disagree,
--      held for review rather than resolved by overwriting.
--
-- A row exists per (connection, remote customer). `party_id` NULL means
-- "unmapped": the profile is known, the person is not yet decided.
CREATE TABLE crm_external_profiles (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Which store/site. Multiple Woo stores are supported by construction.
    connection_id  uuid NOT NULL,
    provider       text NOT NULL DEFAULT 'woocommerce',
    remote_id      text NOT NULL,
    -- The remote snapshot, with provenance. Never treated as authoritative for
    -- a mapped party's own fields — see `conflicts` below.
    remote_name    text NOT NULL DEFAULT '',
    remote_email   text,
    remote_phone   text,
    remote_phone_e164 text,
    remote_address text,
    remote_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    remote_updated_at timestamptz,
    last_synced_at timestamptz,
    -- The mapping.
    party_id       uuid REFERENCES parties(id) ON DELETE SET NULL,
    status         text NOT NULL DEFAULT 'unmapped'
                   CHECK (status IN ('unmapped', 'auto_matched', 'confirmed',
                                     'needs_review', 'conflict', 'ignored')),
    -- 0-100. A number the UI shows next to the word "probable", so a weak
    -- suggestion is never presented as a fact.
    match_confidence integer NOT NULL DEFAULT 0
                   CHECK (match_confidence >= 0 AND match_confidence <= 100),
    match_reason   text NOT NULL DEFAULT '',
    -- The candidates found when the match was ambiguous, so the reconciliation
    -- screen can offer them instead of re-running the search.
    match_candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Field-level disagreements between the remote snapshot and the canonical
    -- party: [{ field, local, remote, seenAt }]. Populated instead of
    -- overwriting; cleared when a human accepts or rejects.
    conflicts      jsonb NOT NULL DEFAULT '[]'::jsonb,
    reviewed_at    timestamptz,
    reviewed_by    text NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, connection_id, remote_id)
);
CREATE INDEX idx_crm_external_profiles_party
    ON crm_external_profiles (business_id, party_id) WHERE party_id IS NOT NULL;
CREATE INDEX idx_crm_external_profiles_status
    ON crm_external_profiles (business_id, status, updated_at DESC);
CREATE INDEX idx_crm_external_profiles_phone
    ON crm_external_profiles (business_id, remote_phone_e164)
    WHERE remote_phone_e164 IS NOT NULL;
CREATE INDEX idx_crm_external_profiles_email
    ON crm_external_profiles (business_id, lower(remote_email))
    WHERE remote_email IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. Typed custom fields
-- ---------------------------------------------------------------------------
--
-- Values are stored as text plus a typed shadow, validated server-side against
-- the definition. No expressions, no executable defaults: a custom field is
-- data, and anything that evaluates user input is a vulnerability wearing a
-- feature's clothes.
CREATE TABLE crm_custom_fields (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    target        text NOT NULL CHECK (target IN ('party', 'lead', 'deal', 'case')),
    key           text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,48}$'),
    label         text NOT NULL CHECK (btrim(label) <> ''),
    field_type    text NOT NULL
                  CHECK (field_type IN ('text', 'number', 'money', 'boolean', 'date', 'select', 'multi_select')),
    -- For select/multi_select: the allowed values, in display order.
    options       jsonb NOT NULL DEFAULT '[]'::jsonb,
    is_required   boolean NOT NULL DEFAULT false,
    help_text     text NOT NULL DEFAULT '',
    display_order integer NOT NULL DEFAULT 0,
    -- Archive rather than delete: stored values must stay explicable.
    archived_at   timestamptz,
    created_by    text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, target, key)
);
CREATE INDEX idx_crm_custom_fields_target
    ON crm_custom_fields (business_id, target, display_order) WHERE archived_at IS NULL;

CREATE TABLE crm_custom_field_values (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    field_id    uuid NOT NULL REFERENCES crm_custom_fields(id) ON DELETE CASCADE,
    -- Exactly one of these is set, matching the field's target.
    party_id    uuid REFERENCES parties(id) ON DELETE CASCADE,
    lead_id     uuid REFERENCES crm_leads(id) ON DELETE CASCADE,
    deal_id     uuid REFERENCES crm_deals(id) ON DELETE CASCADE,
    case_id     uuid REFERENCES crm_cases(id) ON DELETE CASCADE,
    -- The canonical stored form, always text. The typed shadows below are what
    -- a segment filter and a report compare against, written by the service
    -- after validation — never by a cast in a query, which is how an invalid
    -- date becomes a 500 on somebody else's screen.
    value_text  text NOT NULL DEFAULT '',
    value_number numeric,
    value_bool  boolean,
    value_date  date,
    value_list  text[],
    updated_by  text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT crm_custom_field_values_one_target CHECK (
        (party_id IS NOT NULL)::int + (lead_id IS NOT NULL)::int
      + (deal_id IS NOT NULL)::int + (case_id IS NOT NULL)::int = 1
    )
);
CREATE UNIQUE INDEX idx_crm_cfv_party ON crm_custom_field_values (field_id, party_id)
    WHERE party_id IS NOT NULL;
CREATE UNIQUE INDEX idx_crm_cfv_lead ON crm_custom_field_values (field_id, lead_id)
    WHERE lead_id IS NOT NULL;
CREATE UNIQUE INDEX idx_crm_cfv_deal ON crm_custom_field_values (field_id, deal_id)
    WHERE deal_id IS NOT NULL;
CREATE UNIQUE INDEX idx_crm_cfv_case ON crm_custom_field_values (field_id, case_id)
    WHERE case_id IS NOT NULL;
CREATE INDEX idx_crm_cfv_business ON crm_custom_field_values (business_id, field_id);

-- ---------------------------------------------------------------------------
-- 7. Activities and cases: the production fields they were missing
-- ---------------------------------------------------------------------------
ALTER TABLE crm_activities
    ADD COLUMN assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN created_by_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN completed_by_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN completed_by     text NOT NULL DEFAULT '',
    ADD COLUMN lead_id  uuid REFERENCES crm_leads(id) ON DELETE CASCADE,
    ADD COLUMN priority text NOT NULL DEFAULT 'normal'
               CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    ADD COLUMN outcome  text NOT NULL DEFAULT '',
    -- When to remind. A timestamp the notification scan reads; not a second
    -- notification system.
    ADD COLUMN remind_at timestamptz,
    ADD COLUMN reminded_at timestamptz;

CREATE INDEX idx_crm_activities_assignee
    ON crm_activities (business_id, assignee_user_id, due_at)
    WHERE completed_at IS NULL;
CREATE INDEX idx_crm_activities_lead ON crm_activities (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX idx_crm_activities_reminder
    ON crm_activities (business_id, remind_at)
    WHERE completed_at IS NULL AND remind_at IS NOT NULL AND reminded_at IS NULL;

ALTER TABLE crm_cases
    -- A human-readable case number, per business. Allocated by the service
    -- from the sequence table below; people quote it on the phone.
    ADD COLUMN case_number integer,
    ADD COLUMN assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN contact_party_id uuid REFERENCES parties(id) ON DELETE SET NULL,
    ADD COLUMN source text NOT NULL DEFAULT 'manual',
    ADD COLUMN first_response_at timestamptz,
    ADD COLUMN target_due_at timestamptz,
    ADD COLUMN closed_at timestamptz,
    ADD COLUMN reopened_count integer NOT NULL DEFAULT 0 CHECK (reopened_count >= 0),
    -- Total seconds spent in `waiting` (on the customer). SLA reporting
    -- subtracts this: a team should not be judged on a customer's silence.
    ADD COLUMN waiting_seconds bigint NOT NULL DEFAULT 0 CHECK (waiting_seconds >= 0),
    -- When the case last entered `waiting`, so the accumulator above can be
    -- closed out on the way back to an active status.
    ADD COLUMN waiting_since timestamptz;

CREATE UNIQUE INDEX idx_crm_cases_number ON crm_cases (business_id, case_number)
    WHERE case_number IS NOT NULL;
CREATE INDEX idx_crm_cases_assignee ON crm_cases (business_id, assignee_user_id, status)
    WHERE assignee_user_id IS NOT NULL;

-- Per-business case numbering. A table rather than a sequence because a
-- sequence is global and would leak one tenant's volume to another.
CREATE TABLE crm_case_counters (
    business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    next_number integer NOT NULL DEFAULT 1 CHECK (next_number >= 1)
);

-- Case status history, so "how long to first response" and "how long waiting
-- on the customer" are facts rather than guesses.
CREATE TABLE crm_case_events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    case_id      uuid NOT NULL REFERENCES crm_cases(id) ON DELETE CASCADE,
    kind         text NOT NULL
                 CHECK (kind IN ('created', 'status_changed', 'comment', 'assigned',
                                 'first_response', 'resolved', 'reopened', 'closed')),
    from_status  text,
    to_status    text,
    body         text NOT NULL DEFAULT '',
    -- A comment the customer may see versus an internal note.
    is_internal  boolean NOT NULL DEFAULT true,
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    actor_name   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_case_events_case
    ON crm_case_events (business_id, case_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 8. RFM freshness — dirty marking, so scoring is not manual-only
-- ---------------------------------------------------------------------------
--
-- Scoring a whole population inside an order's checkout transaction would make
-- a sale fail because an analytics job failed. So a sale marks the business
-- *dirty* (one cheap UPSERT) and a background tick recomputes. CRM analytics
-- are derived data and must degrade safely.
CREATE TABLE crm_scoring_state (
    business_id     uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    -- Set by any customer-affecting event; cleared by a successful recompute.
    dirty_since     timestamptz,
    last_run_at     timestamptz,
    last_run_status text NOT NULL DEFAULT 'idle'
                    CHECK (last_run_status IN ('idle', 'running', 'ok', 'failed')),
    last_error      text NOT NULL DEFAULT '',
    last_scored_count integer NOT NULL DEFAULT 0,
    -- Guards the tick against two workers scoring one business at once.
    running_since   timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 9. Saved views, segment versions and the CRM audit trail
-- ---------------------------------------------------------------------------
CREATE TABLE crm_saved_views (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    entity       text NOT NULL CHECK (entity IN ('customers', 'leads', 'deals', 'cases', 'activities')),
    name         text NOT NULL CHECK (btrim(name) <> ''),
    -- A filter document, validated against the entity's closed vocabulary by
    -- the service. Never SQL.
    filters      jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- NULL = shared with the business; set = this member's private view.
    owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    is_builtin   boolean NOT NULL DEFAULT false,
    display_order integer NOT NULL DEFAULT 0,
    created_by   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_saved_views_entity
    ON crm_saved_views (business_id, entity, display_order);

-- A campaign launched against a segment must be explainable later: "which
-- definition did this go to?" A version row is appended whenever a segment's
-- definition changes, and the campaign references the version.
CREATE TABLE customer_segment_versions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    segment_id  uuid NOT NULL REFERENCES customer_segments(id) ON DELETE CASCADE,
    version     integer NOT NULL CHECK (version >= 1),
    definition  jsonb NOT NULL,
    name        text NOT NULL DEFAULT '',
    created_by  text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (segment_id, version)
);
CREATE INDEX idx_customer_segment_versions_segment
    ON customer_segment_versions (business_id, segment_id, version DESC);

ALTER TABLE customer_segments
    ADD COLUMN current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1);

-- The CRM's own audit trail. Deliberately narrow: only the decisions a person
-- may have to explain — a conversion, a stage change, a consent change, a
-- merge, a reconciliation. Not a generic event bus; the timeline already reads
-- the owning tables.
CREATE TABLE crm_audit_events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    kind         text NOT NULL,
    entity_type  text NOT NULL,
    entity_id    uuid,
    party_id     uuid,
    summary      text NOT NULL DEFAULT '',
    detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- A stable actor id where there is one; the name is the snapshot beside it.
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    actor_name   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_audit_events_business
    ON crm_audit_events (business_id, created_at DESC);
CREATE INDEX idx_crm_audit_events_entity
    ON crm_audit_events (business_id, entity_type, entity_id, created_at DESC);
CREATE INDEX idx_crm_audit_events_party
    ON crm_audit_events (business_id, party_id, created_at DESC) WHERE party_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 10. Party columns the CRM adds: owner, lifecycle source, data-quality flags
-- ---------------------------------------------------------------------------
ALTER TABLE parties
    -- The member responsible for this relationship. A stable id, unlike the
    -- deal/activity text fields this migration is replacing.
    ADD COLUMN crm_owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    -- First acquisition source, written once and never overwritten by a later
    -- interaction (see src/lib/crm-sources.ts). `last_source` moves.
    ADD COLUMN acquisition_source text,
    ADD COLUMN acquisition_detail text NOT NULL DEFAULT '',
    ADD COLUMN acquisition_at timestamptz,
    ADD COLUMN last_source text,
    ADD COLUMN last_interaction_at timestamptz;

CREATE INDEX idx_parties_crm_owner ON parties (business_id, crm_owner_user_id)
    WHERE crm_owner_user_id IS NOT NULL;
CREATE INDEX idx_parties_acquisition ON parties (business_id, acquisition_source)
    WHERE acquisition_source IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 11. Backfill — nothing is lost
-- ---------------------------------------------------------------------------
--
-- Seed every existing business a default pipeline whose six stages mean
-- exactly what the old CHECK constraint's six strings meant, then point every
-- existing deal at the stage row matching the string it already has. A
-- business that upgrades sees the pipeline it had, with the deals where it
-- left them.
INSERT INTO crm_pipelines (business_id, name, description, is_default, display_order, created_by)
SELECT b.id, 'قیف فروش پیش‌فرض', 'مراحل استاندارد فروش', true, 0, 'migration'
  FROM businesses b
 WHERE NOT EXISTS (SELECT 1 FROM crm_pipelines p WHERE p.business_id = b.id);

INSERT INTO crm_pipeline_stages
    (business_id, pipeline_id, name, legacy_key, display_order, default_probability, outcome)
SELECT p.business_id, p.id, s.name, s.legacy_key, s.display_order, s.probability, s.outcome
  FROM crm_pipelines p
  CROSS JOIN (VALUES
      ('سرنخ',        'lead',        1, 10, 'open'),
      ('واجد شرایط',  'qualified',   2, 30, 'open'),
      ('پیشنهاد',     'proposal',    3, 55, 'open'),
      ('مذاکره',      'negotiation', 4, 75, 'open'),
      ('برنده',       'won',         5, 100, 'won'),
      ('بازنده',      'lost',        6, 0,  'lost')
  ) AS s(name, legacy_key, display_order, probability, outcome)
 WHERE p.is_default
   AND NOT EXISTS (
       SELECT 1 FROM crm_pipeline_stages st
        WHERE st.pipeline_id = p.id AND st.legacy_key = s.legacy_key
   );

-- Point every existing deal at its equivalent stage row. `stage` (the text
-- column) is deliberately left in place and kept in step by the service: it is
-- what every pre-0157 query reads, and dropping it would be a destructive
-- change to satisfy tidiness.
UPDATE crm_deals d
   SET pipeline_id = p.id,
       stage_id = st.id,
       stage_entered_at = COALESCE(d.stage_entered_at, d.updated_at, d.created_at),
       last_activity_at = COALESCE(d.last_activity_at, d.updated_at, d.created_at)
  FROM crm_pipelines p
  JOIN crm_pipeline_stages st ON st.pipeline_id = p.id
 WHERE p.business_id = d.business_id
   AND p.is_default
   AND st.legacy_key = d.stage
   AND d.stage_id IS NULL;

-- Any deal whose stage string matched nothing (data written before a CHECK, or
-- by a future stage) still gets a pipeline and the first open stage, so no
-- deal is orphaned out of the board.
UPDATE crm_deals d
   SET pipeline_id = p.id,
       stage_id = (
         SELECT st.id FROM crm_pipeline_stages st
          WHERE st.pipeline_id = p.id AND st.outcome = 'open'
          ORDER BY st.display_order LIMIT 1
       ),
       stage_entered_at = COALESCE(d.stage_entered_at, d.updated_at, d.created_at)
  FROM crm_pipelines p
 WHERE p.business_id = d.business_id
   AND p.is_default
   AND d.stage_id IS NULL;

-- Seed one history row per existing deal, so "time in stage" has a start even
-- for deals that predate the history table. `from_stage_id` is NULL — this is
-- the deal appearing, not a transition.
INSERT INTO crm_deal_stage_history
    (business_id, deal_id, from_stage_id, to_stage_id, to_stage_name, changed_by, note, created_at)
SELECT d.business_id, d.id, NULL, d.stage_id, COALESCE(st.name, d.stage),
       COALESCE(NULLIF(d.created_by, ''), 'migration'),
       'وضعیت اولیه هنگام ارتقای ساختار قیف فروش', COALESCE(d.created_at, now())
  FROM crm_deals d
  LEFT JOIN crm_pipeline_stages st ON st.id = d.stage_id
 WHERE NOT EXISTS (
     SELECT 1 FROM crm_deal_stage_history h WHERE h.deal_id = d.id
 );

-- Existing cases get a number, ordered by when they were opened so the
-- numbering reads as a history rather than as a shuffle.
WITH numbered AS (
    SELECT id, business_id,
           row_number() OVER (PARTITION BY business_id ORDER BY opened_at, id) AS n
      FROM crm_cases
     WHERE case_number IS NULL
)
UPDATE crm_cases c SET case_number = numbered.n
  FROM numbered WHERE numbered.id = c.id;

INSERT INTO crm_case_counters (business_id, next_number)
SELECT business_id, COALESCE(max(case_number), 0) + 1
  FROM crm_cases GROUP BY business_id
    ON CONFLICT (business_id) DO NOTHING;

INSERT INTO crm_case_counters (business_id, next_number)
SELECT id, 1 FROM businesses
    ON CONFLICT (business_id) DO NOTHING;

-- Seed a version row for every existing segment, so a campaign referencing a
-- segment version always finds one.
INSERT INTO customer_segment_versions (business_id, segment_id, version, definition, name, created_by)
SELECT business_id, id, 1, definition, name, COALESCE(NULLIF(created_by, ''), 'migration')
  FROM customer_segments
    ON CONFLICT (segment_id, version) DO NOTHING;

-- Every business starts with a scoring state row, marked dirty so the first
-- background tick produces scores without anyone pressing a button.
INSERT INTO crm_scoring_state (business_id, dirty_since)
SELECT id, now() FROM businesses
    ON CONFLICT (business_id) DO NOTHING;

-- Existing parties that came from a Woo sync are recognisable by having a
-- customer mapping. Record their acquisition source rather than leaving it
-- blank — an unknown source reported as "manual" would be a lie in the
-- acquisition report.
UPDATE parties p
   SET acquisition_source = 'woocommerce',
       acquisition_at = COALESCE(p.acquisition_at, p.created_at)
 WHERE p.acquisition_source IS NULL
   AND EXISTS (
       SELECT 1 FROM integration_mappings m
        WHERE m.business_id = p.business_id
          AND m.entity_type = 'customer'
          AND m.local_id = p.id
   );

UPDATE parties SET acquisition_source = 'pos', acquisition_at = COALESCE(acquisition_at, created_at)
 WHERE acquisition_source IS NULL;

-- Migrate the existing Woo customer mappings into external profiles. The
-- mapping rows stay exactly where they are — they are the integration's
-- idempotency backbone and other code reads them — but from now on the CRM
-- side of the relationship (status, confidence, conflicts) lives here. An
-- existing mapping is `confirmed`: a human-visible link that has been working.
INSERT INTO crm_external_profiles
    (business_id, connection_id, provider, remote_id, party_id, status,
     match_confidence, match_reason, last_synced_at, created_at, updated_at)
SELECT m.business_id, m.connection_id, 'woocommerce', m.remote_id, m.local_id, 'confirmed',
       100, 'نگاشت موجود پیش از ارتقای ساختار', m.updated_at, m.created_at, m.updated_at
  FROM integration_mappings m
  JOIN parties p ON p.id = m.local_id AND p.business_id = m.business_id
 WHERE m.entity_type = 'customer'
    ON CONFLICT (business_id, connection_id, remote_id) DO NOTHING;

-- Now that every deal has a stage row, the old CHECK is no longer the
-- authority on what a stage may be. Dropped rather than widened: a
-- configurable pipeline cannot have its values enumerated in DDL. The `stage`
-- column itself stays (compatibility), maintained by the service from the
-- stage row's `legacy_key`, falling back to the stage's own name.
ALTER TABLE crm_deals DROP CONSTRAINT IF EXISTS crm_deals_stage_check;

-- ---------------------------------------------------------------------------
-- 12. RLS — one policy per new table, in this same migration
-- ---------------------------------------------------------------------------
ALTER TABLE crm_pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_pipelines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_pipelines FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_pipeline_stages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_pipeline_stages FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_deal_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_deal_stage_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_deal_stage_history FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_leads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_leads FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_party_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_party_relationships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_party_relationships FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_external_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_external_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_external_profiles FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_custom_fields FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_custom_fields FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_custom_field_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_custom_field_values FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_custom_field_values FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_case_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_case_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_case_counters FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_case_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_case_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_scoring_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_scoring_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_scoring_state FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_saved_views FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_saved_views FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE customer_segment_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_segment_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_segment_versions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE crm_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON crm_audit_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
