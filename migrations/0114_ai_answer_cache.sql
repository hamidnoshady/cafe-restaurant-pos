-- ============================================================================
-- 0114_ai_answer_cache.sql — Phase 35 Wave 7 (issue #365)
-- A semantic cache for read-only assistant answers, bound to the branch's
-- business day and to the tool signature the answer was built from.
--
-- Three people in one branch ask «فروش دیروز چقدر بود؟». The second and third
-- should cost nothing. That is the whole feature, and the two hard rules that
-- keep it from being a liability are both in the key:
--
-- 1. `business_date` is the BRANCH'S TRADING DAY, from
--    `app_business_date(ts, tz, start_minutes)` — never a calendar date. A café
--    open 18:00–03:00 runs one service, not two; a key built from the calendar
--    date would carry the pre-midnight answer into the next service.
--
-- 2. `tool_signature` names the read tools and ranges the answer was built
--    from. With it, «فروش امروز» survives neither the day rolling over nor a
--    backdated order (`/api/orders/backdated`) landing inside the same range —
--    a sale typed in late changes the very window the answer summarised.
--
-- Like migration 0113, the whole thing is conditional on pgvector: no
-- extension, no cache table, and `ai-answer-cache.ts` reports the cache off,
-- which is precisely today's behaviour.
-- ============================================================================

DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector unavailable (%); ai_answer_cache will not be created and the cache stays off', SQLERRM;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        RETURN;
    END IF;

    CREATE TABLE IF NOT EXISTS ai_answer_cache (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        -- Null for a business-wide answer; a branch answer never serves another branch.
        location_id        uuid REFERENCES locations(id) ON DELETE CASCADE,
        question_embedding vector(1536) NOT NULL,
        question_text      text NOT NULL,
        -- The branch's trading day, from app_business_date — not a calendar date.
        business_date      date NOT NULL,
        -- Canonical, sorted signature of the read tools + ranges behind the answer.
        tool_signature     text NOT NULL,
        answer             text NOT NULL,
        hit_count          integer NOT NULL DEFAULT 0,
        created_at         timestamptz NOT NULL DEFAULT now(),
        -- Short by design: a safety net under the signature, not the main guard.
        expires_at         timestamptz NOT NULL
    );

    -- The exact-match half of a lookup. Similarity ordering runs inside this.
    CREATE INDEX IF NOT EXISTS idx_ai_answer_cache_lookup
        ON ai_answer_cache (business_id, location_id, business_date, tool_signature);

    -- Invalidation by signature when a write touches a signed range.
    CREATE INDEX IF NOT EXISTS idx_ai_answer_cache_signature
        ON ai_answer_cache (business_id, tool_signature);

    -- Sweeping expired rows.
    CREATE INDEX IF NOT EXISTS idx_ai_answer_cache_expires
        ON ai_answer_cache (expires_at);

    CREATE INDEX IF NOT EXISTS idx_ai_answer_cache_hnsw
        ON ai_answer_cache USING hnsw (question_embedding vector_cosine_ops);

    ALTER TABLE ai_answer_cache ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ai_answer_cache FORCE ROW LEVEL SECURITY;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE tablename = 'ai_answer_cache' AND policyname = 'tenant_isolation'
    ) THEN
        CREATE POLICY tenant_isolation ON ai_answer_cache FOR ALL
            USING (app_rls_bypass() OR business_id = app_current_business())
            WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
    END IF;
END
$$;
