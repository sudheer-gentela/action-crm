-- ─────────────────────────────────────────────────────────────────────────────
-- 2026_34_account_type.sql
--
-- P1 foundation for network job-change plays (Design & Execution Tracker §G-P1).
--
--   1. accounts.account_type — authoritative account classification (D12),
--      replacing the earlier is_customer boolean idea. Drives:
--        • 'customer' → champion-left CHURN play (P1)
--        • 'target'   → moved-into-target-account warm-intro play (P2)
--        • 'churned'  → already-lost account
--        • 'none'     → unclassified (default)
--      Mirrors the existing account_disposition CHECK pattern.
--
--      Backfill: set 'customer' where the account already has a won deal
--      (deals.stage_type='won') OR is linked to a client record (client_id).
--      Everything else stays 'none'; RevOps classifies target/churned by hand
--      (or a future derive pass). Conservative on purpose — we'd rather
--      under-claim 'customer' than mislabel.
--
--   2. connection_job_events.from_account_id / to_account_id — set by the P1+
--      classifier when a move's prior/new company resolves to a known account.
--      Lets the churn play point at the OLD (customer) account and the
--      pursue/target play at the NEW account, and powers the org digest.
--      Additive + nullable.
--
-- ADD COLUMN with a constant default is metadata-only in modern PostgreSQL (no
-- table rewrite). The one-time UPDATE backfill is fine at current volume; on a
-- very large accounts table prefer batching. Idempotent (IF NOT EXISTS; the
-- backfill only touches rows still 'none', so re-running is safe).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. accounts.account_type ──────────────────────────────────────────────────
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS account_type varchar(20) NOT NULL DEFAULT 'none';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
     WHERE table_name = 'accounts' AND constraint_name = 'chk_account_type'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT chk_account_type
      CHECK (account_type IN ('none', 'target', 'customer', 'churned'));
  END IF;
END $$;

COMMENT ON COLUMN accounts.account_type IS
  'Authoritative account classification (D12): none|target|customer|churned. '
  'customer→churn play, target→inbound play. Backfilled from won-deal/client_id, '
  'RevOps-overridable.';

-- Backfill existing customers (won deal OR linked client). Only touches 'none'.
UPDATE accounts a
   SET account_type = 'customer'
 WHERE a.account_type = 'none'
   AND a.deleted_at IS NULL
   AND (
        a.client_id IS NOT NULL
     OR EXISTS (
          SELECT 1 FROM deals d
           WHERE d.account_id = a.id
             AND d.stage_type = 'won'
             AND d.deleted_at IS NULL
        )
   );

-- Lookups like "all target accounts" / "all customers" per org.
CREATE INDEX IF NOT EXISTS idx_accounts_account_type
  ON accounts (org_id, account_type)
  WHERE account_type <> 'none' AND deleted_at IS NULL;


-- ── 2. job-event account linkage ──────────────────────────────────────────────
ALTER TABLE connection_job_events
  ADD COLUMN IF NOT EXISTS from_account_id integer,
  ADD COLUMN IF NOT EXISTS to_account_id   integer;

COMMENT ON COLUMN connection_job_events.from_account_id IS
  'Account the person LEFT, when the prior company resolves to a known account '
  '(set by P1+ classifier). Powers the churn play.';
COMMENT ON COLUMN connection_job_events.to_account_id IS
  'Account the person JOINED, when the new company resolves to a known account '
  '(set by P1+ classifier). Powers the target/pursue play.';

CREATE INDEX IF NOT EXISTS idx_connection_job_events_from_account
  ON connection_job_events (org_id, from_account_id)
  WHERE from_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_connection_job_events_to_account
  ON connection_job_events (org_id, to_account_id)
  WHERE to_account_id IS NOT NULL;

COMMIT;
