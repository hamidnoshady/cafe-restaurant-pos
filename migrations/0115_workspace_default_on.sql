-- ============================================================================
-- 0115_workspace_default_on.sql — Phase 35 follow-up (workspace is the shell)
--
-- 0110 shipped the workspace (chat home + app rail) behind a feature flag with
-- default_enabled = false so it could roll out one business at a time. The
-- shell is now the product's main sidebar — the rail keeps only «حسابداری» and
-- «رشد و بازاریابی» as launchers into the classic product — so the catalogue
-- default flips to ON. Businesses that were explicitly switched off keep their
-- override (business_features rows are untouched); everyone else gets the
-- workspace the way a new signup would.
-- ============================================================================

UPDATE feature_flags
   SET default_enabled = true
 WHERE key = 'workspace';
