-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: ai_credentials → org_credentials (with purpose column)
-- Sprint 3 (Group E)
-- ─────────────────────────────────────────────────────────────────────────────
-- Two changes:
--
--   1. RENAME ai_credentials → org_credentials. The table will hold credentials
--      for any purpose (LLM, enrichment, email, e-sign, ...). The shape stays
--      the same — same encryption, same FK to users and organizations.
--
--   2. ADD purpose column. Default 'ai' so all existing rows are tagged as
--      LLM credentials (which is what they are today). New code paths
--      (enrichment, etc.) pass purpose explicitly.
--
-- The OLD uniqueness constraint was (org_id, user_id, provider) for active
-- rows. We replace it with (org_id, purpose, user_id, provider) so an org can
-- hold both an 'anthropic' AI key AND an 'apollo' enrichment key (even if some
-- future provider name overlaps — purpose distinguishes them).
--
-- Idempotent: each ALTER guards with IF EXISTS / IF NOT EXISTS; the rename
-- step short-circuits if the table already exists under the new name.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Rename the table ──────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ai_credentials')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'org_credentials')
  THEN
    ALTER TABLE ai_credentials RENAME TO org_credentials;
    RAISE NOTICE 'Renamed ai_credentials → org_credentials';
  ELSIF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'org_credentials') THEN
    RAISE NOTICE 'org_credentials already exists, skipping rename';
  ELSE
    RAISE EXCEPTION 'Neither ai_credentials nor org_credentials exists — cannot proceed';
  END IF;
END $$;

-- ── 2. Add the purpose column ────────────────────────────────────────────────
-- Default 'ai' so every existing row is correctly tagged as an LLM credential.
-- New code paths pass purpose explicitly.
ALTER TABLE org_credentials
  ADD COLUMN IF NOT EXISTS purpose VARCHAR(20) NOT NULL DEFAULT 'ai';

-- Check constraint for the allowed purpose values. Open-ish set: we can add
-- new values here as we add new purposes. Not enforced at the DB level for
-- now — app code does richer validation.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_credentials_purpose_check'
  ) THEN
    ALTER TABLE org_credentials
      ADD CONSTRAINT org_credentials_purpose_check
      CHECK (purpose IN ('ai', 'enrichment', 'email', 'esign', 'storage'));
  END IF;
END $$;

-- ── 3. Drop old uniqueness constraints / indexes that lack purpose ───────────
-- Different orgs created these via the original ai_credentials migration, so
-- the exact name may vary. We try common names; failures are silently OK.
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'org_credentials'::regclass
       AND contype  = 'u'
       AND conname  LIKE '%provider%'
  LOOP
    EXECUTE format('ALTER TABLE org_credentials DROP CONSTRAINT %I', rec.conname);
    RAISE NOTICE 'Dropped old unique constraint: %', rec.conname;
  END LOOP;
END $$;

-- Drop the legacy partial unique index if present.
DROP INDEX IF EXISTS ai_credentials_org_user_provider_active_idx;
DROP INDEX IF EXISTS org_credentials_org_user_provider_active_idx;

-- ── 4. New uniqueness — one active credential per (org, purpose, user, provider) ──
-- Partial index: only active rows compete for the unique slot. Revoked rows
-- can pile up over time without conflicting.
CREATE UNIQUE INDEX IF NOT EXISTS org_credentials_active_unique
  ON org_credentials (org_id, purpose, COALESCE(user_id, 0), provider)
  WHERE status = 'active';

-- ── 5. Lookup index for the hot path ─────────────────────────────────────────
-- The credential resolver hits (org_id, purpose, provider) on every call.
CREATE INDEX IF NOT EXISTS idx_org_credentials_lookup
  ON org_credentials (org_id, purpose, provider)
  WHERE status = 'active';

COMMIT;
