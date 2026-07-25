-- ═══════════════════════════════════════════════════════════════════════════
-- 2026_70b_actions_status_default.sql
--
-- HOTFIX to 2026_70. Numbered 70b deliberately so the 71→77 sequence claimed by
-- A5b and the plan's downstream migrations is not disturbed.
--
-- Migration 70 added actions_status_check (canonical vocabulary only) but did
-- NOT move actions.status's column DEFAULT, which is still 'yet_to_start'.
-- Migration 70 DID set the default on deal_play_instances, case_plays and
-- contract_play_instances — actions was the omission.
--
-- Consequence: every INSERT INTO actions that omits the status column takes the
-- invalid default and fails actions_status_check immediately. Five such sites
-- exist and are all currently erroring in production:
--
--   backend/services/transcriptAnalyzer.js:246
--   backend/services/salesforce.sync.service.js:252
--   backend/services/salesforce.sync.service.js:579
--   backend/services/aiProcessor.js:419
--   backend/services/emailActionsService.js:32
--
-- None of these contain the string 'yet_to_start', which is why the grep-driven
-- A3 sweep did not surface them.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- §0. PRE-FLIGHT — confirms the problem before changing anything.
--     Expect: 'yet_to_start'
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT column_default
--   FROM information_schema.columns
--  WHERE table_name = 'actions' AND column_name = 'status';


ALTER TABLE actions ALTER COLUMN status SET DEFAULT 'not_started';


-- ───────────────────────────────────────────────────────────────────────────
-- §1. VERIFY before COMMIT.
--
--     Query 1 expects: 'not_started'::character varying
--     Query 2 expects: zero rows (no action outside the canonical vocabulary)
-- ───────────────────────────────────────────────────────────────────────────
-- SELECT column_default
--   FROM information_schema.columns
--  WHERE table_name = 'actions' AND column_name = 'status';
--
-- SELECT status, count(*) FROM actions
--  WHERE status NOT IN ('not_started','in_progress','blocked','snoozed',
--                       'completed','skipped','cancelled')
--  GROUP BY 1;

COMMIT;

-- ───────────────────────────────────────────────────────────────────────────
-- NOT FIXED HERE — flagged for a decision (see handover notes):
--
-- trg_sync_action_completed (added by migration 70) fires BEFORE INSERT and
-- sets completed := (status = 'completed') unconditionally. Two of the five
-- INSERT sites above (salesforce.sync.service.js:252 in particular) supply
-- completed / completed_at from Salesforce but no status. Once this migration
-- makes those inserts succeed, the trigger will overwrite completed to false
-- on tasks that Salesforce reports as already Completed.
--
-- Fixing that means either (a) having the sync pass an explicit status, or
-- (b) narrowing the trigger so it does not clobber an explicitly-supplied
-- completed on INSERT. (b) is a schema change and is deliberately NOT bundled
-- here. This migration is safe either way — it strictly replaces an invalid
-- default with a valid one.
-- ───────────────────────────────────────────────────────────────────────────
