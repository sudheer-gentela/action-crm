-- 2026_18_linkedin_auto_connect.sql
--
-- Optional auto-send of LinkedIn connection-request sequence steps.
--
-- This migration is additive and safe to run on a live DB:
--   • New JSONB column on org_action_config (defaults to '{}' → every org
--     resolves to SYSTEM_DEFAULTS, i.e. auto_connect_enabled = false). No org
--     changes behaviour until an admin explicitly turns the toggle on.
--   • Two nullable lease columns on sequence_step_logs so a 'scheduled'
--     LinkedIn connection-request row can be safely LEASED to one LinkedIn seat
--     while the extension performs the click, and auto-reclaimed if the rep's
--     browser goes away mid-flight. Nullable + defaulted → no backfill, no
--     rewrite of existing rows.
--
-- Mirrors the column-add shape of 2026_15_org_action_config_prospecting_escalation.sql.
--
-- Rollback (manual):
--   ALTER TABLE org_action_config DROP COLUMN IF EXISTS linkedin_automation;
--   ALTER TABLE sequence_step_logs DROP COLUMN IF EXISTS claimed_by_seat;
--   ALTER TABLE sequence_step_logs DROP COLUMN IF EXISTS lease_expires_at;
--   DROP INDEX IF EXISTS idx_seq_step_logs_li_lease;

BEGIN;

-- ── (1) Org-level config bucket ──────────────────────────────────────────────
-- Read/written by services/linkedinAutomationConfig.js. Shape:
--   { auto_connect_enabled, daily_cap, jitter_seconds:{min,max},
--     human_hours:{start_hour,end_hour,days[]}, lease_minutes }
-- Missing keys resolve to SYSTEM_DEFAULTS in the service layer.
ALTER TABLE org_action_config
  ADD COLUMN IF NOT EXISTS linkedin_automation jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN org_action_config.linkedin_automation IS
  'Optional LinkedIn connection-request auto-send. Org-admin master toggle + defensive guardrails (daily cap, jitter band, human-hours window, lease ttl). Empty = SYSTEM_DEFAULTS (disabled). Per-user opt-in lives in user_preferences.preferences->''linkedin_auto_connect''.';

-- Backfill existing rows to an explicit empty object (DEFAULT already covers
-- new rows; this normalizes any pre-existing NULL just in case the column ever
-- existed nullable in a branch).
UPDATE org_action_config
   SET linkedin_automation = '{}'::jsonb
 WHERE linkedin_automation IS NULL;

-- ── (2) Lease columns for extension-driven sends ─────────────────────────────
-- A LinkedIn connection-request step that is eligible for auto-send is
-- materialized as a sequence_step_logs row with status='scheduled' and
-- channel='linkedin'. The extension claims it (scheduled → sending) by setting
-- claimed_by_seat + lease_expires_at, performs the click in the rep's browser,
-- then confirms (sending → sent) or reports failure (sending → failed). If the
-- lease expires while still 'sending', the firer reclaims it back to
-- 'scheduled' so it can be re-offered. (Email auto-sends never set these and
-- are unaffected.)
ALTER TABLE sequence_step_logs
  ADD COLUMN IF NOT EXISTS claimed_by_seat  text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamp with time zone;

COMMENT ON COLUMN sequence_step_logs.claimed_by_seat IS
  'LinkedIn public_identifier (user_linkedin_seats) that leased this row for auto-send. NULL for email/manual rows.';
COMMENT ON COLUMN sequence_step_logs.lease_expires_at IS
  'When a sending-status LinkedIn auto-send lease expires and may be reclaimed to scheduled. NULL when not leased.';

-- Partial index: the firer reclaim sweep and the per-seat "what can I claim"
-- query both filter to leased/claimable LinkedIn rows only.
CREATE INDEX IF NOT EXISTS idx_seq_step_logs_li_lease
  ON sequence_step_logs (lease_expires_at)
  WHERE channel = 'linkedin' AND status = 'sending';

COMMIT;
