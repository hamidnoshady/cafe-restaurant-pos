-- ============================================================================
-- 0112_ai_prompt_templates.sql — Phase 35 Wave 4 (issue #362)
-- Platform-level prompt fragment overrides. NOT tenant-scoped — this is a
-- platform table like platform_ai_config. A row here overrides the code
-- default for a given fragment key + version; absence falls back to code.
--
-- "The DB row overrides the code default, not merely its version."
-- A bad edit or unmigrated deploy must not silence the assistant.
-- ============================================================================

CREATE TABLE ai_prompt_templates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    fragment_key    text NOT NULL,
    version         integer NOT NULL DEFAULT 1,
    text            text NOT NULL,
    is_active       boolean NOT NULL DEFAULT false,
    created_by      text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- One active version per fragment key (partial unique index)
CREATE UNIQUE INDEX idx_ai_prompt_templates_active
    ON ai_prompt_templates (fragment_key)
    WHERE is_active = true;

-- Lookup by key + version
CREATE INDEX idx_ai_prompt_templates_key_version
    ON ai_prompt_templates (fragment_key, version DESC);
