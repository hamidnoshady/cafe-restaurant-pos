-- ============================================================================
-- 0113_ai_embeddings.sql — Phase 35 Wave 6 (issue #364)
-- Retrieval over business knowledge (RAG), on pgvector when the extension is
-- there and silently absent when it is not.
--
-- Two decisions are load-bearing and both are visible in this file.
--
-- 1. THE EXTENSION IS OPTIONAL. `docker-compose.yml` and CI can move to
--    `pgvector/pgvector:pg16`, but `electron/main.js` embeds a real
--    `embedded-postgres` on a café laptop and almost certainly has no `vector`
--    extension available at all. A migration that hard-failed there would take
--    down the whole desktop installer for a feature that is a nice-to-have.
--    So the CREATE EXTENSION is wrapped in a DO block that swallows its own
--    failure, and everything that depends on it is created conditionally.
--    A café on the desktop installer loses RAG, not the assistant.
--
-- 2. NO NUMBERS ARE EVER COPIED INTO A VECTOR. `kind` covers slow-moving text
--    only — help pages, written policy, item and menu descriptions, project
--    notes, customer and item names for approximate-name lookup. Orders,
--    stock, payments and ledger rows are never embedded: a vector copy of
--    those is stale within minutes on a POS and makes the model *confidently*
--    wrong about a figure. Numbers stay where they are and are read through
--    tools.
-- ============================================================================

-- Conditional extension. A deployment without the shared library, or without
-- rights to create extensions, must not lose the whole migration run.
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector unavailable (%); ai_embeddings will not be created and retrieval stays off', SQLERRM;
END
$$;

-- Everything below only exists when the extension does. `ai-rag.ts` probes for
-- the table once and, finding it absent, never declares the retrieval tool —
-- so the assistant behaves exactly as it does today.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        RETURN;
    END IF;

    CREATE TABLE IF NOT EXISTS ai_embeddings (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        -- 'help' | 'policy' | 'procedure' | 'item' | 'menu_item' | 'project_note' | 'customer'
        kind         text NOT NULL,
        -- The id of the row this text came from, so a result can name its source.
        ref_id       text NOT NULL,
        -- A short human label for the source, shown with every retrieval result.
        source_label text NOT NULL DEFAULT '',
        content      text NOT NULL,
        embedding    vector(1536) NOT NULL,
        -- The `updated_at` of the source row when it was embedded. The indexing
        -- tick picks up stragglers by comparing against this.
        source_updated_at timestamptz,
        updated_at   timestamptz NOT NULL DEFAULT now()
    );

    -- One vector per (business, kind, ref). Re-embedding upserts.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_embeddings_ref
        ON ai_embeddings (business_id, kind, ref_id);

    -- Retrieval is always inside withTenant, so the business_id filter is the
    -- hot predicate; the HNSW index serves the ordering within it.
    CREATE INDEX IF NOT EXISTS idx_ai_embeddings_business_kind
        ON ai_embeddings (business_id, kind);

    CREATE INDEX IF NOT EXISTS idx_ai_embeddings_hnsw
        ON ai_embeddings USING hnsw (embedding vector_cosine_ops);

    -- Staleness scan for the indexing tick.
    CREATE INDEX IF NOT EXISTS idx_ai_embeddings_updated
        ON ai_embeddings (business_id, updated_at);

    -- RLS in the same migration as the table, per CLAUDE.md. A vector belonging
    -- to one business must never be retrievable by another.
    ALTER TABLE ai_embeddings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ai_embeddings FORCE ROW LEVEL SECURITY;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE tablename = 'ai_embeddings' AND policyname = 'tenant_isolation'
    ) THEN
        CREATE POLICY tenant_isolation ON ai_embeddings FOR ALL
            USING (app_rls_bypass() OR business_id = app_current_business())
            WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
    END IF;
END
$$;
