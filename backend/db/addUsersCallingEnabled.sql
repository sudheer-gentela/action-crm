-- scripts/addUsersCallingEnabled.sql
--
-- Adds the individual-level calling revoke flag used by the calling entitlement
-- layer. Pairs with the ORG-level flag (organizations.settings.entitlements.calling):
-- a rep can place a call only when the org is calling-entitled AND their own
-- users.calling_enabled is true.
--
-- Safe + additive: ADD COLUMN with a constant DEFAULT is a metadata-only change
-- in modern Postgres (no table rewrite), so it's instant even on a large users
-- table. Default TRUE means every existing rep keeps calling; revoke is opt-in
-- per rep via PATCH /api/org/admin/twilio/reps/:userId/calling.
--
-- Idempotent (IF NOT EXISTS) — safe to run more than once.
--
-- Run at deploy time, e.g. via the Railway/psql console:
--   psql "$DATABASE_URL" -f scripts/addUsersCallingEnabled.sql
--
-- The application code is written to tolerate this column being absent (reads
-- fail open to "enabled"), so a brief deploy-before-migrate window won't block
-- calling — but run this so the per-rep toggle actually persists.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS calling_enabled BOOLEAN NOT NULL DEFAULT TRUE;
