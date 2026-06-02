-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: add org_action_config.prospecting_escalation (the missing column)
-- 2026_15_org_action_config_prospecting_escalation.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- ProspectingEscalationService (services/prospectingEscalation.service.js) was
-- written to read/write org_action_config.prospecting_escalation (JSONB), but
-- no migration ever created that column and it is absent from the live DB.
--
-- Effect of the missing column today:
--   • PUT /org/admin/prospecting-escalation (setForOrg) → the upsert references
--     a non-existent column, Postgres throws, and the route returns HTTP 500.
--     Admins cannot save any per-org escalation policy.
--   • getForOrg() and the nightly notificationScheduler.js catch the error and
--     fall back to SYSTEM_DEFAULTS — so escalations still fire, but ONLY on
--     system defaults; org-level overrides are silently impossible.
--
-- This is the one-line, no-code-change fix: add the column. The service
-- already merges an empty '{}' blob over SYSTEM_DEFAULTS, so:
--   • every existing org (blob '{}') resolves to exactly today's effective
--     behaviour — no behavioural change, no data migration required;
--   • saving now succeeds, and saved overrides take effect.
--
-- Spec mirrors the sibling domain blobs on this table (call_settings,
-- enrichment): JSONB NOT NULL DEFAULT '{}'. NOT NULL + the empty-object default
-- also guarantee the `col || $patch::jsonb` merge in setForOrg never operates
-- on NULL.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE org_action_config
  ADD COLUMN IF NOT EXISTS prospecting_escalation JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Defensive: if the column somehow pre-existed as NULLable with NULLs present,
-- normalise them so setForOrg's `prospecting_escalation || $patch` merge is safe.
UPDATE org_action_config
   SET prospecting_escalation = '{}'::jsonb
 WHERE prospecting_escalation IS NULL;

COMMIT;
