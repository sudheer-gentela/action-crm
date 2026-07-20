-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_57_prospect_sales_profile_id.sql
--
-- Durable Sales Navigator identity for prospects: the fs_salesProfile id — the
-- opaque token in urn:li:fs_salesProfile:(<id>,<authType>,<authToken>), e.g.
-- ACwAAABfNZYBW88qylwnDTl1QNrZKo99i_Raj3g.
--
-- WHY (Option A — bulk lead capture from Sales Navigator lists/searches):
-- A Sales-Nav *list/search* row exposes NO public /in/ URL and NO fsd_profile
-- URN — its only durable identity is this fs_salesProfile id. Without storing
-- it, a bulk-added lead could not dedup against (a) other list captures or
-- (b) a later full-profile / /in/ capture of the same person, and we'd create
-- duplicates. This is the people analogue of accounts.linkedin_company_id.
--
-- HOW IT CONVERGES WITH THE EXISTING KEYS (see prospects.routes.js POST /):
--   • member_urn  (urn:li:fsd_profile:…)  — captured on /in/*  (strongest)
--   • sales_profile_id (this column)      — captured on Sales Navigator
--   • linkedin_url slug (/in/<slug>)      — the bridge between the two
-- Dedup precedence is member_urn → sales_profile_id → slug. A Sales-Nav *core*
-- capture carries BOTH the sales_profile_id AND the public flagshipProfileUrl,
-- so when it matches a row (by any key) it backfills whichever of
-- {sales_profile_id, linkedin_url} is still empty — never overwriting a good
-- value. That is what lets a list-added row (id only, no URL) later acquire its
-- public URL passively as the rep browses, and lets a Sales-Nav id and an /in/
-- slug collapse onto one prospect instead of two.
--
-- Stored as TEXT: an opaque identity token we only ever compare for equality.
-- We store the fs_salesProfile *id* part only (not the authType/authToken, which
-- are context-scoped and not identity).
--
-- Deliberately NOT unique (same reasoning as member_urn / linkedin_company_id):
--   • Global-unique would collide across orgs (same person, two tenants).
--   • Per-org-unique would make a concurrent second capture FAIL rather than
--     leave a reconcilable row. App logic (id-first match) prevents duplicates;
--     any pre-existing duplicates are left for a later cleanup pass.
--
-- Additive + nullable: ADD COLUMN with no default is a metadata-only change in
-- PostgreSQL (no table rewrite). Safe to run more than once.
--
-- NOTE: on a large prospects table, prefer creating the index CONCURRENTLY
-- outside a transaction to avoid a write lock:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prospects_sales_profile_id
--     ON prospects (org_id, sales_profile_id)
--     WHERE sales_profile_id IS NOT NULL AND deleted_at IS NULL;
-- The in-transaction form below is fine at current (dogfood) volume.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS sales_profile_id text;

COMMENT ON COLUMN prospects.sales_profile_id IS
  'Stable LinkedIn Sales Navigator fs_salesProfile id (the opaque token in '
  'urn:li:fs_salesProfile:(<id>,…)). Captured by the Chrome extension from '
  'Sales-Nav lists/searches/profiles. The only durable identity a Sales-Nav '
  'list row carries. Used for capture-time dedup (member_urn → sales_profile_id '
  '→ slug). Nullable, non-unique, set only when empty (never overwritten).';

CREATE INDEX IF NOT EXISTS idx_prospects_sales_profile_id
  ON prospects (org_id, sales_profile_id)
  WHERE sales_profile_id IS NOT NULL AND deleted_at IS NULL;

COMMIT;
