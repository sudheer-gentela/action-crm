-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_29_prospect_member_urn.sql
--
-- Durable LinkedIn identity for prospects: the fsd_profile URN
-- (urn:li:fsd_profile:…). Captured by the Chrome extension from LinkedIn's own
-- profile request — owner-bound to the /in/<slug> on the page — and stored here.
--
-- WHY: the /in/<slug> in prospects.linkedin_url is mutable (people change their
-- vanity URL); the fsd_profile URN is stable. With the URN stored, the LinkedIn
-- auto-send path can target the member directly instead of doing a per-send
-- live resolve against a rotating queryId hash, and capture-time dedup can match
-- URN-first so a slug change UPDATES the existing prospect's URL rather than
-- creating a duplicate (see prospects.routes.js POST /).
--
-- Deliberately NOT unique:
--   • Global-unique would collide across orgs (same person, two tenants).
--   • Per-org-unique would make the second capture during a slug-change window
--     FAIL rather than create a detectable row to reconcile later. We prefer to
--     let app logic (URN-first dedup) prevent duplicates and leave any pre-URN
--     duplicates for a later cleanup pass.
-- The index below is a plain partial index for fast (org_id, member_urn) lookup.
--
-- Additive + nullable: ADD COLUMN with no default is a metadata-only change in
-- PostgreSQL (no table rewrite). Safe to run more than once.
--
-- NOTE: on a large prospects table, prefer creating the index CONCURRENTLY
-- outside a transaction to avoid a write lock:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prospects_member_urn
--     ON prospects (org_id, member_urn)
--     WHERE member_urn IS NOT NULL AND deleted_at IS NULL;
-- The in-transaction form below is fine at current (dogfood) volume.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS member_urn text;

COMMENT ON COLUMN prospects.member_urn IS
  'Stable LinkedIn fsd_profile URN (urn:li:fsd_profile:…). Captured by the Chrome '
  'extension, owner-bound to the profile slug. Preferred over linkedin_url for '
  'auto-send targeting and capture-time dedup (slug-change resilient). Nullable, '
  'non-unique by design.';

CREATE INDEX IF NOT EXISTS idx_prospects_member_urn
  ON prospects (org_id, member_urn)
  WHERE member_urn IS NOT NULL AND deleted_at IS NULL;

COMMIT;
