-- scripts/addUsersCallingEnabled.sql
--
-- Adds the individual-level calling flag used by the calling entitlement layer.
-- Calling is OPT-IN at both levels — a rep can place a call only when BOTH:
--   - the ORG is calling-entitled  (organizations.settings.entitlements.calling = true), AND
--   - the REP is enabled           (users.calling_enabled = true)
-- Both default to FALSE: nobody calls until deliberately turned on.
--
-- Safe + additive: ADD COLUMN with a constant DEFAULT is a metadata-only change
-- in modern Postgres (no table rewrite), so it's instant even on a large users
-- table.
--
-- IMPORTANT — running this sets calling_enabled = FALSE for ALL existing reps,
-- so every current rep loses calling until explicitly enabled (per rep via
-- PATCH /api/org/admin/twilio/reps/:userId/calling). That is the intended
-- opt-in behaviour.
--
-- Idempotent (IF NOT EXISTS) — safe to re-run.
--
-- Run at deploy time:
--   psql "$DATABASE_URL" -f scripts/addUsersCallingEnabled.sql
--
-- The application code tolerates this column being absent (the per-user gate
-- fails OPEN pre-migration to avoid a calling outage during the deploy window),
-- so a brief deploy-before-migrate gap won't block calls. Strict opt-in takes
-- effect the moment this runs.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS calling_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- ── OPTIONAL grandfather (recommended) ───────────────────────────────────────
-- Without this, the line above turns OFF every rep that is currently calling.
-- This re-enables reps who already hold a provisioned DID (i.e. were actively
-- set up to call) so you don't break in-flight calling on deploy. New reps
-- still default OFF. DELETE this statement if you want a true clean slate
-- (all reps off, enable each deliberately).
UPDATE users
   SET calling_enabled = TRUE
 WHERE twilio_did IS NOT NULL;
