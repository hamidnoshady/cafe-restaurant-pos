-- Repair — restore 'mcp' to ai_action_audit_source_check.
--
-- The check constraint on `ai_action_audit.source` records how an assistant
-- write was authorised. It has grown one value at a time:
--
--   0041 created it with ('manual', 'autopilot')
--   0097 / 0100 widened it to include 'coworker'
--   0101 (MCP connector) widened it to include 'mcp'
--   0155 (this program's automation engine) redefined it as
--        ('manual', 'autopilot', 'coworker', 'agent', 'automation')
--
-- 0155 was written on a branch whose base predated the MCP connector, so it
-- listed the values it *knew* about and, in redefining the constraint from
-- scratch, silently dropped 'mcp'. On any database that already has the MCP
-- connector (0101) this makes every MCP-authorised write fail the check —
-- `performMcpWrite` sets `source = 'mcp'` — the moment 0155 is applied.
--
-- This restores the union of every legitimate source. It is additive and
-- idempotent-safe: 0155 is left untouched (migrations are never rewritten), and
-- redefining the constraint to the full set is a no-op wherever the value was
-- already present. No data changes — existing rows already hold one of these
-- six values.
ALTER TABLE ai_action_audit
    DROP CONSTRAINT ai_action_audit_source_check,
    ADD CONSTRAINT ai_action_audit_source_check
        CHECK (source IN ('manual', 'autopilot', 'coworker', 'mcp', 'agent', 'automation'));
