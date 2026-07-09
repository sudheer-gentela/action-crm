-- ============================================================================
-- 2026_45_activity_report_config.sql
--
-- Activity Reporting (Team Reporting → Activity tab).
--
-- Adds org_action_config.activity_report (JSONB) holding the ORG DEFAULT
-- roll-up definition for the action-metrics builder:
--
--   {
--     "definition": {
--       "numerator":   ["rep_completed"],
--       "denominator": ["pending","in_progress","snoozed","skipped",
--                       "failed","rep_completed"]
--     },
--     "updated_by": <user_id>,
--     "updated_at": "<iso>"
--   }
--
-- NULL / missing → the system default above is used (resolved in
-- services/activityReportConfig.js — single source of truth for the
-- default and the state whitelist).
--
-- USER-saved definitions need no schema change: they live in the existing
-- user_preferences.preferences JSONB under the 'activity_report' key,
-- same pattern as 'notifications' and 'linkedin_auto_connect'.
--
-- Rollback:
--   ALTER TABLE org_action_config DROP COLUMN IF EXISTS activity_report;
-- ============================================================================

BEGIN;

ALTER TABLE org_action_config
  ADD COLUMN IF NOT EXISTS activity_report jsonb;

COMMENT ON COLUMN org_action_config.activity_report IS
  'Org-default roll-up definition for the Activity reporting tab (numerator/denominator over action-state atoms). NULL = system default. User-level saved definitions live in user_preferences.preferences.activity_report.';

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'org_action_config' AND column_name = 'activity_report';
