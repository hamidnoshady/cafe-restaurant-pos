-- Phase 21 Wave 1 — domain-event log + posting engine foundation.
--
-- Today, every auto-posted journal entry is produced by its own dedicated
-- function (postOrderPaymentEntry, postCogsEntry, postPurchaseEntry,
-- postWasteEntry, ... in src/lib/ledger-service.ts / inventory-service.ts),
-- each hand-written against that one event. That doesn't scale to a second,
-- third, and fourth industry each with their own sale/repair/consignment
-- events -- it would mean a new hand-written posting function per event per
-- industry. This table plus src/lib/posting-engine.ts's registry is the
-- alternative: a business event is recorded once, generically, and a
-- registered rule turns it into a balanced journal entry via the existing
-- postJournalEntry() -- so a new industry's posting logic is a registration,
-- not a new copy of ledger code.
--
-- Deliberately NOT wired to F&B's existing posting paths in this migration --
-- those functions are proven, tested, and load-bearing; re-pointing them at
-- this engine is its own reviewable follow-up slice, not bundled sight
-- unseen into the engine's introduction.
CREATE TABLE domain_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
    event_type  text NOT NULL,
    payload     jsonb NOT NULL,
    source_type text,
    source_id   uuid,
    -- Set once a registered rule successfully posts this event; NULL means
    -- either "no rule registered yet" or "posting still pending" -- the
    -- engine never leaves an event half-posted, so this is always exactly
    -- one of those two states, never a partial one.
    entry_id    uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_domain_events_business_created ON domain_events (business_id, created_at);
CREATE INDEX idx_domain_events_business_type ON domain_events (business_id, event_type);
CREATE INDEX idx_domain_events_unposted ON domain_events (business_id) WHERE entry_id IS NULL;

ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON domain_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
