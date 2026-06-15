-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_27_prospect_phones.sql
--
-- Multiple phone numbers per prospect (mobile / office / direct / …), with one
-- designated primary. Replaces the single prospects.phone field as the source
-- of dialable numbers, while KEEPING prospects.phone as a denormalized mirror
-- of the primary so existing code that reads prospects.phone keeps working.
--
-- Dialing safety: the call flow freezes the chosen number onto calls.phone_used
-- at /prepare (validated against this table), and /voice-app dials phone_used —
-- it never trusts a client-supplied number.
--
-- Mirror contract (maintained in prospect-phones.routes.js):
--   prospects.phone == the is_primary=true row's phone, or NULL if none.
--
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS prospect_phones (
  id           bigserial    PRIMARY KEY,
  org_id       integer      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prospect_id  integer      NOT NULL REFERENCES prospects(id)     ON DELETE CASCADE,
  phone        varchar(64)  NOT NULL,               -- E.164 preferred (e.g. +14155551234)
  label        varchar(40),                         -- e.g. mobile, office, direct, home
  is_primary   boolean      NOT NULL DEFAULT false,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now()
);

-- No duplicate numbers within one prospect.
CREATE UNIQUE INDEX IF NOT EXISTS uq_prospect_phones_prospect_phone
  ON prospect_phones (prospect_id, phone);

-- At most one primary per prospect.
CREATE UNIQUE INDEX IF NOT EXISTS uq_prospect_phones_one_primary
  ON prospect_phones (prospect_id) WHERE is_primary;

-- Listing / org-scoped lookups.
CREATE INDEX IF NOT EXISTS idx_prospect_phones_org_prospect
  ON prospect_phones (org_id, prospect_id);

-- Backfill: every prospect with a non-empty phone gets a primary row.
-- ON CONFLICT keeps the migration idempotent across re-runs.
INSERT INTO prospect_phones (org_id, prospect_id, phone, label, is_primary)
SELECT org_id, id, btrim(phone), 'primary', true
  FROM prospects
 WHERE phone IS NOT NULL
   AND btrim(phone) <> ''
   AND deleted_at IS NULL
ON CONFLICT (prospect_id, phone) DO NOTHING;

COMMIT;
