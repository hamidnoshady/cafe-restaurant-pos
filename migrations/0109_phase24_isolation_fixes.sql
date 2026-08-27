-- Phase 24 follow-up: two tenant-isolation gaps left by migrations 0072/0074.
--
-- 1. business_encryption_keys enabled row-level security and wrote a policy,
--    but never FORCEd it. Without FORCE, the table's *owner* bypasses RLS
--    entirely — and the owner role is what runs migrations, the backup dump,
--    and any maintenance script. Every other tenant table in this schema is
--    both ENABLEd and FORCEd (see 0021 and every table added since), and
--    integration/tenant-isolation.integration.test.ts asserts exactly that
--    pair. This is the table holding each business's wrapped data-encryption
--    key, so it is the last one that should be the exception.
--
--    The policy itself is also widened to carry a WITH CHECK arm. A
--    USING-only policy filters reads and the rows an UPDATE may touch, but
--    places no constraint on what an INSERT writes, so a bug in scoped code
--    could store a row stamped with another business's id and then be unable
--    to see it. The added arm makes writes obey the same boundary as reads.
--
-- 2. rate_limits is deliberately NOT tenant-scoped, and this records why so
--    the isolation test's exempt list has something to point at. Its keys are
--    IP addresses and hashed bearer tokens counted *before* any business is
--    known — the login bucket exists precisely for requests that have no
--    session yet — so there is no business_id to scope by. It holds no tenant
--    data: a key, a count, and a window start.

ALTER TABLE business_encryption_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "business_encryption_keys_tenant_isolation" ON business_encryption_keys;
CREATE POLICY "business_encryption_keys_tenant_isolation" ON business_encryption_keys
  FOR ALL
  USING (business_id = nullif(current_setting('app.business_id', TRUE), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', TRUE), '')::uuid);

-- Counters are transient by nature: a row whose window closed long ago is
-- dead weight, and the table is keyed by caller, so it grows with every
-- distinct IP ever seen. The middleware sweep only ever touched the in-process
-- Maps, never this table.
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start ON rate_limits (window_start);
