-- =====================================================================
-- 2026_132_daily_work_account_target_and_vocab.sql
--
-- Three changes to the daily work tables from 2026_131, all driven by
-- what the pilot walkthrough surfaced.
--
-- ── 1. account_id — SNAPSHOTTED, NOT JOINED ──────────────────────────
--
-- Managers need to answer "what has been delivered to this account,
-- day by day". The obvious implementation is a join at read time:
-- entry -> anchor -> handover -> account. Three reasons that is wrong.
--
--   a) It rewrites history. sales_handovers.account_id is mutable. If a
--      project is re-parented to a different account in November, a live
--      join silently moves October's work with it. That is the same
--      class of error as joining department at read time, which
--      2026_131 already rejected for department_team_id.
--
--   b) One of the three anchor kinds cannot reach an account at all.
--      prospecting_campaigns has no account column — only
--      sender_account_ids, which is mailboxes, not customers. Campaign
--      work is internal by definition and carries no account.
--
--   c) The bucket a manager thinks of as "Internal Projects" is not an
--      accounts row and deliberately never will be. Creating one per
--      customer organization would put a non-customer into every
--      account picker in the product. Internal is derived instead:
--      an item with an anchor but no account is internal; an item with
--      no anchor at all is unattributed. Those are different states and
--      the second one is a data-quality signal worth seeing.
--
-- So account_id is resolved ONCE at write and copied onto both the item
-- and each entry, exactly like department_team_id, activity_type_key
-- and the anchor pair. Resolution at write time:
--
--      anchor_kind = 'account'   -> anchor_id
--      anchor_kind = 'handover'  -> sales_handovers.account_id
--      anchor_kind = 'campaign'  -> NULL  (internal by definition)
--      anchor_kind IS NULL       -> NULL  (unattributed)
--
-- ON DELETE SET NULL rather than RESTRICT: accounts are soft-deleted in
-- this product (accounts.deleted_at), so a hard delete is an
-- administrative act. When one happens, daily work history should
-- degrade to "no account" rather than block an unrelated deletion.
--
-- ── 2. target_date — ADVISORY ONLY ───────────────────────────────────
--
-- A manager assigning a finite deliverable wants to set an expectation.
-- 2026_131 deliberately had no due date, because the design replaced
-- due dates with staleness detection to avoid the overdue-accumulation
-- failure this codebase already demonstrates elsewhere — one rep with
-- 583 overdue actions that grew for 19 days and was never opened.
--
-- This column does NOT reintroduce that. It is advisory: it drives
-- display and sort order only. It generates no status, fires no
-- notification, and nothing anywhere is ever "overdue". If a future
-- change wants to escalate on it, that is a new decision to be argued
-- on its own merits, not an obvious extension of this column.
--
-- The CHECK enforces in the database what the UI enforces in the form:
-- only assigned work can carry a target date. Recurring work never
-- completes, so a date by which it should be done is meaningless.
--
-- ── 3. status vocabulary — yet_to_start, not not_started ─────────────
--
-- 2026_131 shipped two words for one idea: daily_work_items.status used
-- 'not_started' while daily_work_entries.day_stage used 'yet_to_start'.
-- Every read that moves between an item and its entries would have to
-- translate, and the first place someone forgets is a silent empty
-- result rather than an error.
--
-- This aligns the item on the ENTRY's word, for two reasons. The design
-- record names the four user-facing options as "Yet to Start / In
-- Progress / Complete / Dropped", so yet_to_start is the one already
-- written down. And day_stage is the higher-traffic column — one row
-- per item per day against one row per item.
--
-- Doing it now is close to free: the tables are empty, no service code
-- exists, and nothing queries them. It gets more expensive every week.
--
-- IMPORTANT — 'not_started' elsewhere is NOT this. actions,
-- project_play_instances, sales_handovers.internal_approval_status and
-- one other table all use 'not_started' for their own concepts and are
-- untouched by this migration. Do not "finish the job" by renaming
-- those; they are a different vocabulary that happens to share a word.
--
-- ── NOT IN THIS MIGRATION ────────────────────────────────────────────
--
-- Row-level security. The seven tables from 2026_131 have none, while
-- 52 other tables in this schema do. That is a real gap and it is left
-- open deliberately, pending a decision, in its own migration
-- (2026_133) so it can be applied independently. Note that the cost of
-- enabling it is entirely in retrofitting existing queries, and there
-- are currently NO queries against these tables — so it is cheaper to
-- decide before the service layer is written than after.
--
-- ── VERIFICATION ─────────────────────────────────────────────────────
--
-- Run verify_daily_work_132.js after applying. It asserts the columns,
-- the CHECK by name, the indexes, and that a recurring item carrying a
-- target date is refused.
--
-- Idempotent: safe to re-run. Every statement guards on existence.
-- =====================================================================

BEGIN;

-- ── 1. account_id on items ───────────────────────────────────────────

ALTER TABLE daily_work_items
  ADD COLUMN IF NOT EXISTS account_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_dwi_account'
  ) THEN
    ALTER TABLE daily_work_items
      ADD CONSTRAINT fk_dwi_account
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN daily_work_items.account_id IS
  'Snapshot, resolved once at write from the anchor. NEVER re-derive by '
  'joining: sales_handovers.account_id is mutable and a live join would '
  'rewrite closed history. NULL means internal work or unattributed.';

-- ── 2. account_id on entries ─────────────────────────────────────────

ALTER TABLE daily_work_entries
  ADD COLUMN IF NOT EXISTS account_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_dwen_account'
  ) THEN
    ALTER TABLE daily_work_entries
      ADD CONSTRAINT fk_dwen_account
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN daily_work_entries.account_id IS
  'Snapshot copied from the item at write time. Account filters read THIS '
  'column, not the item and not a join, so a project re-parented later '
  'cannot move work that was already logged.';

-- ── 3. target_date on items, assigned work only ──────────────────────

ALTER TABLE daily_work_items
  ADD COLUMN IF NOT EXISTS target_date date;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_dwi_target_date_kind'
  ) THEN
    ALTER TABLE daily_work_items
      ADD CONSTRAINT chk_dwi_target_date_kind
      CHECK (target_date IS NULL OR kind = 'assigned');
  END IF;
END $$;

COMMENT ON COLUMN daily_work_items.target_date IS
  'ADVISORY. Display and sort only. Generates no status, no notification, '
  'and no overdue state anywhere. Recurring work cannot carry one.';

-- ── 4. Status vocabulary: not_started -> yet_to_start ────────────────
--
-- Guarded on the constraint definition rather than on a row count, so
-- re-running is safe and so applying it to a database where 2026_131 is
-- missing fails loudly instead of half-working.

DO $$
DECLARE
  def text;
  moved integer;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint WHERE conname = 'chk_dwi_status_by_kind';

  IF def IS NULL THEN
    RAISE EXCEPTION 'chk_dwi_status_by_kind is missing — apply 2026_131 first';
  END IF;

  IF position('yet_to_start' in def) = 0 THEN
    -- Drop first: the rows cannot be updated while the old CHECK stands,
    -- and the new CHECK cannot be added while old rows remain.
    ALTER TABLE daily_work_items DROP CONSTRAINT chk_dwi_status_by_kind;

    UPDATE daily_work_items
       SET status = 'yet_to_start', updated_at = now()
     WHERE status = 'not_started';
    GET DIAGNOSTICS moved = ROW_COUNT;
    RAISE NOTICE 'daily_work_items rows moved to yet_to_start: %', moved;

    ALTER TABLE daily_work_items
      ADD CONSTRAINT chk_dwi_status_by_kind CHECK (
        (kind = 'assigned'  AND status IN ('yet_to_start','in_progress','in_review','completed','dropped'))
        OR
        (kind = 'recurring' AND status IN ('active','retired'))
      );
  ELSE
    RAISE NOTICE 'status vocabulary already aligned — nothing to do';
  END IF;
END $$;

-- Belt and braces: prove the old word is gone before the transaction commits.
DO $$
DECLARE stragglers integer;
BEGIN
  SELECT count(*) INTO stragglers FROM daily_work_items WHERE status = 'not_started';
  IF stragglers > 0 THEN
    RAISE EXCEPTION '% daily_work_items rows still hold not_started', stragglers;
  END IF;
END $$;

-- ── 5. Indexes ───────────────────────────────────────────────────────
--
-- Partial, because most rows will have NULL in both columns: internal
-- work carries no account, and recurring work carries no target date.

CREATE INDEX IF NOT EXISTS idx_dwi_account
  ON daily_work_items (org_id, account_id)
  WHERE account_id IS NOT NULL;

-- The account view is "this account, most recent first", so entry_date
-- descends inside the index rather than being sorted afterwards.
CREATE INDEX IF NOT EXISTS idx_dwen_account_date
  ON daily_work_entries (org_id, account_id, entry_date DESC)
  WHERE account_id IS NOT NULL;

-- Dropped and recreated rather than CREATE IF NOT EXISTS, because a
-- database that already ran an earlier draft of this file would hold the
-- index with the old not_started predicate, and IF NOT EXISTS would
-- leave that stale definition in place — an index whose WHERE clause can
-- never match anything.
DROP INDEX IF EXISTS idx_dwi_target;
CREATE INDEX idx_dwi_target
  ON daily_work_items (org_id, target_date)
  WHERE target_date IS NOT NULL
    AND status IN ('yet_to_start', 'in_progress', 'in_review');

COMMIT;

-- =====================================================================
-- Deploy notes — what breaks if a piece is missing
--
-- 1. Without account_id on ENTRIES (only on items), the account filter
--    would have to join entry -> item, and an item re-anchored later
--    would move its own history. The column exists on both tables on
--    purpose; do not "normalise" it away.
--
-- 2. Without chk_dwi_target_date_kind, a recurring item could carry a
--    target date, and the roll-up would show a deadline on work that by
--    definition never completes.
--
-- 3. Without idx_dwen_account_date, the account delivery view degrades
--    to a sequential scan of every entry in the org. It is fine at ten
--    people and not fine at a hundred.
--
-- 4. If the status rename is skipped, every join between an item and its
--    entries needs a translation layer, and the first read that forgets
--    it returns an empty result rather than an error. There is no
--    migration to add that translation back cheaply once rows exist.
--
-- 5. The two immutability trigger functions on play_evidence and
--    play_notes enumerate their columns by name. This migration adds no
--    column to either table, so they are untouched — but if a later
--    migration does, both functions must be edited in that same
--    migration or the new column is silently unguarded.
-- =====================================================================
