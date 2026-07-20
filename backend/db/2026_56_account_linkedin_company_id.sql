-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_56_account_linkedin_company_id.sql
--
-- Durable, cross-surface LinkedIn identity for accounts: the numeric company id
-- (e.g. 9261371). This is the same integer LinkedIn uses across every surface —
-- urn:li:company:<id>, urn:li:fs_salesCompany:<id>, urn:li:fsd_company:<id> — and
-- linkedin.com/company/<id> resolves to the public page. It is the account
-- analogue of prospects.member_urn: a stable key that survives vanity-slug
-- changes and reconciles the SAME company captured from different surfaces.
--
-- WHY: accounts today are keyed on linkedin_company_url (a mutable vanity slug,
-- e.g. /company/path-robotics) and domain. Sales Navigator's company/account
-- API responses do NOT expose the public /company/ URL or the domain as a
-- structured field — they expose only the numeric id (urn:li:fs_salesCompany:<id>)
-- and the name. Without a numeric-id key, a Sales-Nav account capture cannot
-- match the account you already have (from a regular /company/ capture or from a
-- lead's domain) and would create a duplicate. Storing the numeric id lets:
--   • a Sales-Nav account-page capture match/enrich the existing account,
--   • a Sales-Nav lead (whose position carries companyUrn:fs_salesCompany:<id>)
--     resolve to the same account, and
--   • a regular /company/ capture converge on the same key over time.
--
-- Stored as TEXT (not bigint): the id is an opaque identifier we only ever
-- compare for equality, never do arithmetic on; TEXT sidesteps any risk of a
-- value outside int range and matches how member_urn is stored.
--
-- Deliberately NOT unique (same reasoning as prospects.member_urn):
--   • Global-unique would collide across orgs (same company, two tenants).
--   • Per-org-unique would make a concurrent second capture FAIL rather than
--     leave a reconcilable row. We prefer app logic (id-first match) to prevent
--     duplicates and leave any pre-id duplicates for a later cleanup pass.
--
-- ADDITIVE + BACKFILL-ONLY at the app layer: the matcher/resolver only ever
-- SETs this column when it is NULL (never overwrites), and the equivalence
-- "fs_salesCompany:<id> == public company <id>" is treated as a match/backfill
-- hint only — worst case on a wrong id is a missed match (a duplicate), never a
-- wrong merge.
--
-- Additive + nullable: ADD COLUMN with no default is a metadata-only change in
-- PostgreSQL (no table rewrite). Safe to run more than once.
--
-- NOTE: on a large accounts table, prefer creating the index CONCURRENTLY
-- outside a transaction to avoid a write lock:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_accounts_linkedin_company_id
--     ON accounts (org_id, linkedin_company_id)
--     WHERE linkedin_company_id IS NOT NULL AND deleted_at IS NULL;
-- The in-transaction form below is fine at current (dogfood) volume.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS linkedin_company_id text;

COMMENT ON COLUMN accounts.linkedin_company_id IS
  'Stable LinkedIn numeric company id (e.g. 9261371) — the same integer across '
  'urn:li:company / fs_salesCompany / fsd_company and /company/<id>. Captured by '
  'the Chrome extension. Preferred over linkedin_company_url for capture-time '
  'account dedup (slug-change resilient, and the only structured key Sales '
  'Navigator exposes for a company). Nullable, non-unique by design; set only '
  'when empty, never overwritten.';

CREATE INDEX IF NOT EXISTS idx_accounts_linkedin_company_id
  ON accounts (org_id, linkedin_company_id)
  WHERE linkedin_company_id IS NOT NULL AND deleted_at IS NULL;

COMMIT;
