-- Phase 16 — manual journals, properly: draft -> review -> post, and
-- reversal rather than deletion.
--
-- Drafts live in their own tables rather than as a status on journal_entries.
-- journal_entries/journal_lines back every existing statement, subledger,
-- and reconciliation query in this phase with no status filter at all — a
-- 'draft' status on that table would have meant auditing and patching every
-- one of those queries to exclude it. A draft has zero financial effect
-- until approved, so it isn't a journal entry yet; approving it calls the
-- same postJournalEntry() path (and therefore the same fiscal-period lock
-- trigger, migration 0024) any other posting goes through, at exactly the
-- point a real posting is created. This also means the trigger itself needs
-- no change: a draft, living outside journal_entries, never reaches it.
--
-- Reversal is the opposite question — it always posts a real, immediate
-- journal_entries row (Debit/Credit swapped from the original), so it
-- deliberately reuses postJournalEntry() and goes through the trigger
-- exactly like a fresh manual entry, dated whenever it's recorded rather
-- than backdated into the original's (possibly now-locked) period — "you
-- don't reopen a closed period to fix a mistake, you post a reversing entry
-- today." reverses_entry_id marks the reversal itself; reversed_at/
-- reversed_by mark the original, so an entry can only ever be reversed once
-- and a reversal can never itself be reversed.

ALTER TABLE journal_entries
    ADD COLUMN reverses_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    ADD COLUMN reversed_at       timestamptz,
    ADD COLUMN reversed_by       uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_journal_entries_reverses_entry_id
    ON journal_entries (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

CREATE TABLE journal_entry_drafts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
    entry_date  date,
    memo        text NOT NULL,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_journal_entry_drafts_business ON journal_entry_drafts (business_id);

CREATE TABLE journal_entry_draft_lines (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_id   uuid NOT NULL REFERENCES journal_entry_drafts(id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    debit      bigint NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit     bigint NOT NULL DEFAULT 0 CHECK (credit >= 0),
    CONSTRAINT journal_entry_draft_lines_debit_xor_credit CHECK (debit = 0 OR credit = 0)
);
CREATE INDEX idx_journal_entry_draft_lines_draft ON journal_entry_draft_lines (draft_id);

ALTER TABLE journal_entry_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entry_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON journal_entry_drafts FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- journal_entry_draft_lines → journal_entry_drafts (business_id), same shape as journal_lines → journal_entries.
ALTER TABLE journal_entry_draft_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entry_draft_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON journal_entry_draft_lines FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM journal_entry_drafts d
         WHERE d.id = journal_entry_draft_lines.draft_id
           AND d.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM journal_entry_drafts d
         WHERE d.id = journal_entry_draft_lines.draft_id
           AND d.business_id = app_current_business()));
