-- ============================================================================
-- 0007_ledger.sql — Phase 7 (Double-Entry Ledger)
--
--   * accounts / journal_entries / journal_lines already exist from 0001
--     (foundation stubbed the Phase 7 tables ahead of time). This migration
--     adds the one thing that stub didn't cover:
--       - purchases.settlement_method: how a received purchase is paid,
--         decided at receiving time (not creation time, since a draft/PO
--         doesn't need this yet). 'credit' (supplier terms, the default —
--         posts to Accounts Payable) | 'cash' | 'bank'. See Phase 7 doc,
--         "Accounts Payable handling".
-- ============================================================================

ALTER TABLE purchases
    ADD COLUMN settlement_method text NOT NULL DEFAULT 'credit'
        CHECK (settlement_method IN ('cash', 'bank', 'credit'));
