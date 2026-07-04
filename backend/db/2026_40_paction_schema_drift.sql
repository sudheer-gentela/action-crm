-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_40_paction_channel_general.sql
--
-- Signal-Based Campaigns — Phase 7 hardening (schema-drift fix, not a feature).
--
-- WHY: db/schema.sql's chk_paction_channel allows only
--   NULL | email | linkedin | phone | sms | whatsapp
-- but two long-shipped writers insert channel='general':
--   • ProspectDiagnosticsEngine (diagnostic alerts, pre-signal era)
--   • SignalActionSurfacer      (P5 signal actions; P7 find-replacement tasks)
-- Production evidently carries a looser constraint than the schema.sql dump —
-- a database stood up fresh from schema.sql rejects those inserts (found while
-- validating P7 against a clean Postgres 16). This migration makes fresh
-- installs match the running system: add 'general' to the allowed set.
--
-- Idempotent: drop-if-exists + re-add. Safe to run more than once. NOT VALID
-- + VALIDATE keeps the lock window minimal on a large live table.
-- ─────────────────────────────────────────────────────────────────────────────

-- SECOND DRIFT, same family: schema.sql gives `actions` an auto_completed
-- column but not `prospecting_actions` — yet ProspectDiagnosticsEngine
-- (_resolveStale) and SignalActionSurfacer (_resolve) both UPDATE
-- prospecting_actions.auto_completed. Their try/catch swallows the 42703, so
-- on a schema.sql-fresh database resolve-stale SILENTLY NO-OPS (stale
-- diagnostics and disqualified signal actions never clear). Production must
-- carry the column; fresh installs get it here.

BEGIN;

ALTER TABLE prospecting_actions
  ADD COLUMN IF NOT EXISTS auto_completed boolean NOT NULL DEFAULT false;

ALTER TABLE prospecting_actions
  DROP CONSTRAINT IF EXISTS chk_paction_channel;

ALTER TABLE prospecting_actions
  ADD CONSTRAINT chk_paction_channel
  CHECK (
    channel IS NULL OR channel::text = ANY (ARRAY[
      'email', 'linkedin', 'phone', 'sms', 'whatsapp', 'general'
    ]::text[])
  ) NOT VALID;

ALTER TABLE prospecting_actions
  VALIDATE CONSTRAINT chk_paction_channel;

COMMIT;
